import { handleAdmin } from './admin.js';

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const db = env.office_attendance_db;
		const ipAddress = request.headers.get("cf-connecting-ip") || "Local_Test_IP";
		
		const cookieHeader = request.headers.get("Cookie") || "";
		const deviceTokenMatch = cookieHeader.match(/device_token=([^;]+)/);
		const deviceToken = deviceTokenMatch ? deviceTokenMatch[1] : null;

		// --- GET ROOT: UI & State Handling ---
		if (url.pathname === "/" && request.method === "GET") {
			const nonce = crypto.randomUUID();
			await db.prepare("INSERT INTO auth_nonces (nonce) VALUES (?)").bind(nonce).run();
			
			let viewState = 'register';
			let hasSignedInToday = false;
			let hasSignedOutToday = false;
			let activeException = null;
			
			if (deviceToken) {
				const activeEmp = await db.prepare("SELECT * FROM employees WHERE device_token = ? AND status = 'active'").bind(deviceToken).first();
				if (activeEmp) {
					viewState = 'attendance';
					
					const todayLogs = await db.prepare(`
						SELECT action_type FROM attendance_logs 
						WHERE emp_number = ? AND verified = 1
						AND date(timestamp, '+3 hours') = date('now', '+3 hours')
					`).bind(activeEmp.emp_number).all();
					
					if (todayLogs && todayLogs.results) {
						hasSignedInToday = todayLogs.results.some(l => l.action_type === 'SIGN_IN');
						hasSignedOutToday = todayLogs.results.some(l => l.action_type === 'SIGN_OUT');
					}

					activeException = await db.prepare(`
						SELECT * FROM status_exceptions
						WHERE emp_number = ? 
						AND date('now', '+3 hours') >= start_date 
						AND date('now', '+3 hours') <= end_date
					`).bind(activeEmp.emp_number).first();
				}
			}

			const response = new Response(getAppHTML(viewState, nonce, hasSignedInToday, activeException, hasSignedOutToday), {
				headers: { "Content-Type": "text/html;charset=UTF-8" },
			});

			if (deviceToken && viewState === 'register') {
				response.headers.append("Set-Cookie", "device_token=; HttpOnly; Secure; Path=/; Max-Age=0");
			}

			return response;
		}

		// --- GET IP API (For Admin Dashboard Auto-Gather) ---
		if (url.pathname === "/api/my-ip" && request.method === "GET") {
			return new Response(ipAddress, { headers: { "Content-Type": "text/plain" } });
		}

		// --- POST REGISTER: Device Binding & Anti-Spoofing ---
		if (url.pathname === "/api/register" && request.method === "POST") {
			const formData = await request.formData();
			const firstName = formData.get("first_name").trim();
			const lastName = formData.get("last_name").trim();
			const submittedDivision = formData.get("division");
			
			const fullName = `${firstName} ${lastName}`.replace(/\s+/g, ' ');
			const newToken = crypto.randomUUID();

			const existingEmp = await db.prepare("SELECT * FROM employees WHERE full_name = ? COLLATE NOCASE").bind(fullName).first();

			if (existingEmp) {
				if (existingEmp.status === 'terminated') {
					return new Response(`<span class="text-red-600 font-bold block mt-4 text-center">Registration Denied:<br>Account is terminated.</span>`, { status: 403 });
				}
				if (existingEmp.device_token !== null) {
					return new Response(`<span class="text-red-600 font-bold block mt-4 text-center">Registration Denied:<br>Name is already bound to an active device.</span>`, { status: 403 });
				}
				
				// RE-ATTACHMENT SCENARIO (Detached but Active)
				await db.prepare("UPDATE employees SET device_token = ? WHERE emp_number = ?").bind(newToken, existingEmp.emp_number).run();
				
				return new Response(`<span class="text-green-600 font-bold block mt-4 text-center">Device Re-attached.<br>Refreshing...</span>`, {
					headers: {
						"Content-Type": "text/html",
						"Set-Cookie": `device_token=${newToken}; HttpOnly; Secure; Path=/; Max-Age=31536000`,
						"HX-Refresh": "true"
					}
				});
			} else {
				// BRAND NEW USER SCENARIO
				const newEmpNumber = "ID-" + crypto.randomUUID().split('-')[0].toUpperCase();
				await db.prepare("INSERT INTO employees (emp_number, full_name, division, device_token, status) VALUES (?, ?, ?, ?, 'active')").bind(newEmpNumber, fullName, submittedDivision, newToken).run();
				
				return new Response(`<span class="text-green-600 font-bold block mt-4 text-center">Registration Successful.<br>Refreshing...</span>`, {
					headers: {
						"Content-Type": "text/html",
						"Set-Cookie": `device_token=${newToken}; HttpOnly; Secure; Path=/; Max-Age=31536000`,
						"HX-Refresh": "true"
					}
				});
			}
		}

		// --- POST LOG: GPS & Wi-Fi Attendance Logic ---
		if (url.pathname === "/api/log" && request.method === "POST") {
			const formData = await request.formData();
			const lat = parseFloat(formData.get("latitude"));
			const lon = parseFloat(formData.get("longitude"));
			const actionType = formData.get("action_type");
			const nonce = formData.get("auth_nonce");

			const nonceCheck = await db.prepare("SELECT * FROM auth_nonces WHERE nonce = ?").bind(nonce).first();
			if (!nonceCheck) return new Response("Invalid session.", { status: 403 });
			await db.prepare("DELETE FROM auth_nonces WHERE nonce = ?").bind(nonce).run();

			if (!deviceToken) return new Response("Unauthorized device.", { status: 401 });
			const emp = await db.prepare("SELECT * FROM employees WHERE device_token = ? AND status = 'active'").bind(deviceToken).first();
			if (!emp) return new Response("Invalid or terminated employee.", { status: 403 });
			const empNumber = emp.emp_number;

			const locations = await db.prepare("SELECT * FROM office_locations").all();
			if (!locations.results || locations.results.length === 0) {
				return new Response(`<span class="text-red-600 font-bold text-sm block">System error: No office locations configured. Contact IT.</span>`, { headers: { "Content-Type": "text/html" } });
			}

			let verified = 0;
			let closestDistance = Infinity;
			let activeLocationName = "Unknown";
			let flagReason = "Location/Network mismatch";
			let bestMatch = null;

			for (const loc of locations.results) {
				const dist = calculateDistance(lat, lon, loc.latitude, loc.longitude);
				if (dist < closestDistance) closestDistance = dist;
				
				const allowedIpsArray = loc.allowed_ips.split(',').map(ip => ip.trim());
				const ipMatches = ipAddress === "Local_Test_IP" || allowedIpsArray.some(allowedIp => {
					if (allowedIp.endsWith('*')) return ipAddress.startsWith(allowedIp.slice(0, -1));
					return ipAddress === allowedIp;
				});

				const strictGpsMatch = dist <= loc.radius_meters;
				const networkDriftMatch = ipMatches && dist <= 2000;

				if (strictGpsMatch || networkDriftMatch) {
					if (!bestMatch || (ipMatches && !bestMatch.ipMatched) || (dist < bestMatch.dist)) {
						bestMatch = { loc, dist, ipMatched: ipMatches };
					}
				}
			}

			if (bestMatch) {
				verified = 1;
				flagReason = null;
				activeLocationName = bestMatch.loc.name;
				closestDistance = bestMatch.dist; 
			} else {
				flagReason = `GPS: ${Math.round(closestDistance)}m from nearest office | IP: ${ipAddress}`;
			}

			await db.prepare("INSERT INTO attendance_logs (emp_number, action_type, latitude, longitude, ip_address, verified, flag_reason, distance_meters) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(empNumber, actionType, lat, lon, ipAddress, verified, flagReason, Math.round(closestDistance)).run();
			
			if (verified === 1) {
				return new Response(`<span class="text-green-600 font-bold">Success! Refreshing...</span>`, { headers: { "Content-Type": "text/html", "HX-Refresh": "true" } });
			} else {
				return new Response(`<span class="text-red-600 font-bold text-sm text-center block">Failed checks: ${flagReason}.<br>Logged for review.</span>`, { headers: { "Content-Type": "text/html" } });
			}
		}

		// --- POST EXCEPTION: Leave / Workshop Logic ---
		if (url.pathname === "/api/exception" && request.method === "POST") {
			const formData = await request.formData();
			const type = formData.get("type");
			const startDate = formData.get("start_date");
			const endDate = formData.get("end_date");
			const description = formData.get("description") || null;

			if (!deviceToken) return new Response("Unauthorized device.", { status: 401 });
			const emp = await db.prepare("SELECT * FROM employees WHERE device_token = ? AND status = 'active'").bind(deviceToken).first();
			if (!emp) return new Response("Invalid or terminated employee.", { status: 403 });

			await db.prepare("INSERT INTO status_exceptions (emp_number, type, start_date, end_date, notified_person, description) VALUES (?, ?, ?, ?, ?, ?)")
				.bind(emp.emp_number, type, startDate, endDate, 'System', description).run();
			
			return new Response(`<span class="text-green-600 font-bold">Status Submitted. Refreshing...</span>`, { headers: { "Content-Type": "text/html", "HX-Refresh": "true" } });
		}

		// --- ADMIN ROUTES ---
		if (url.pathname.startsWith("/admin")) {
			return handleAdmin(request, env, url);
		}

		return new Response("Not Found", { status: 404 });
	}
};

function calculateDistance(lat1, lon1, lat2, lon2) {
	const R = 6371e3; 
	const p1 = lat1 * Math.PI/180;
	const p2 = lat2 * Math.PI/180;
	const dp = (lat2-lat1) * Math.PI/180;
	const dl = (lon2-lon1) * Math.PI/180;

	const a = Math.sin(dp/2) * Math.sin(dp/2) +
			Math.cos(p1) * Math.cos(p2) *
			Math.sin(dl/2) * Math.sin(dl/2);
	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
	return R * c; 
}

function getAppHTML(viewState, nonce, hasSignedInToday = false, activeException = null, hasSignedOutToday = false) {
	const registerForm = `
		<h1 class="text-2xl font-bold mb-2 text-gray-800">Device Registration</h1>
		<form hx-post="/api/register" hx-target="#form-container" class="space-y-4 text-left">
			<div class="flex gap-4">
				<div class="w-1/2"><label class="block text-gray-700 text-sm font-bold mb-2">First Name</label><input type="text" name="first_name" required class="shadow border rounded w-full py-2 px-3"></div>
				<div class="w-1/2"><label class="block text-gray-700 text-sm font-bold mb-2">Last Name</label><input type="text" name="last_name" required class="shadow border rounded w-full py-2 px-3"></div>
			</div>
			<div>
				<label class="block text-gray-700 text-sm font-bold mb-2">Division</label>
				<select name="division" required class="shadow border rounded w-full py-2 px-3 bg-white">
					<option value="" disabled selected>Select your division...</option>
					<option value="ICT Connectivity">ICT Connectivity</option>
					<option value="Data-Centre and Cloud Services">Data-Centre and Cloud Services</option>
					<option value="Field Services">Field Services</option>
				</select>
			</div>
			<button type="submit" class="bg-blue-600 text-white px-6 py-3 rounded-lg font-semibold hover:bg-blue-700 w-full mt-4">Bind Device & Register</button>
		</form>
	`;

	let attendanceForm = '';

	if (activeException) {
		attendanceForm = `
			<h1 class="text-2xl font-bold mb-4 text-gray-800">Status: Out of Office</h1>
			<div class="bg-blue-50 border border-blue-200 p-6 rounded-lg text-left mb-4 shadow-sm">
				<div class="flex items-center gap-3 mb-2">
					<div class="w-3 h-3 bg-blue-500 rounded-full animate-pulse"></div>
					<h2 class="text-lg font-bold text-blue-900">${activeException.type}</h2>
				</div>
				<p class="text-sm text-blue-800 mt-2">You are currently excused from standard office attendance logging.</p>
				<p class="text-sm text-blue-800 mt-1">Valid through: <span class="font-bold">${activeException.end_date}</span></p>
				${activeException.description ? `<p class="text-xs text-blue-600 mt-3 p-2 bg-blue-100/50 rounded italic">Details: ${activeException.description}</p>` : ''}
			</div>
			<p class="text-xs text-gray-500 mt-4">Attendance and leave requests are disabled until this period expires.</p>
		`;
	} else {
		const eatDate = new Date(new Date().toLocaleString("en-US", {timeZone: "Africa/Nairobi"}));
		const hour = eatDate.getHours();
		
		const canSignIn = hour >= 4 && hour < 17;
		const canSignOut = hour >= 17 || hour < 4;

		let actionButtonsHTML = '';
		const showExceptionForm = !hasSignedInToday && !hasSignedOutToday;

		if (canSignIn) {
			if (hasSignedInToday) {
				actionButtonsHTML = `
					<div class="w-full bg-green-50 text-green-800 px-4 py-8 rounded-xl font-bold shadow-sm border border-green-200 text-center flex flex-col items-center gap-2">
						<svg class="w-12 h-12 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
						<span class="text-xl tracking-tight">Successfully Signed In</span>
						<span class="text-sm font-normal mt-1 text-green-600">Sign-out will become available at 17:00 EAT.</span>
					</div>`;
			} else {
				actionButtonsHTML = `<button onclick="logLocation('SIGN_IN')" class="bg-green-600 text-white px-2 py-5 rounded-xl font-bold text-xl hover:bg-green-700 w-full shadow-lg transition-transform active:scale-95">SIGN IN</button>`;
			}
		} else if (canSignOut) {
			if (hasSignedOutToday) {
				actionButtonsHTML = `
					<div class="w-full bg-gray-50 text-gray-700 px-4 py-8 rounded-xl font-bold shadow-sm border border-gray-200 text-center flex flex-col items-center gap-2">
						<svg class="w-12 h-12 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"></path></svg>
						<span class="text-xl tracking-tight">Shift Complete</span>
						<span class="text-sm font-normal mt-1 text-gray-500">Next sign-in available at 04:00 EAT.</span>
					</div>`;
			} else {
				actionButtonsHTML = `<button onclick="logLocation('SIGN_OUT')" class="bg-red-600 text-white px-2 py-5 rounded-xl font-bold text-xl hover:bg-red-700 w-full shadow-lg transition-transform active:scale-95">SIGN OUT</button>`;
			}
		}

		let exceptionSectionHTML = '';
		if (showExceptionForm) {
			exceptionSectionHTML = `
				<hr class="my-6 border-gray-200">
				<div id="exception-section" class="text-left bg-gray-50 p-4 rounded-lg border border-gray-200">
					<h2 class="text-lg font-bold text-gray-800 mb-2">Out of Office / Leave</h2>
					<form hx-post="/api/exception" hx-target="#exception-section" class="space-y-3">
						<select name="type" required class="shadow border rounded w-full py-2 px-3 text-sm bg-white">
							<option value="Workshop/Inspection">Workshop / Inspection</option>
							<option value="Sick Leave">Sick Leave</option>
							<option value="Annual Leave">Annual / Work Leave</option>
						</select>
						<div class="flex gap-4">
							<input type="date" name="start_date" required class="shadow border rounded w-1/2 py-1 px-2 text-sm">
							<input type="date" name="end_date" required class="shadow border rounded w-1/2 py-1 px-2 text-sm">
						</div>
						<input type="text" name="description" class="shadow border rounded w-full py-2 px-3 text-sm" placeholder="Description or Notified Person">
						<button type="submit" class="bg-blue-600 text-white px-4 py-2 rounded-lg font-semibold w-full text-sm mt-2 hover:bg-blue-700 transition-colors">Submit Status</button>
					</form>
				</div>
			`;
		}

		attendanceForm = `
			<h1 class="text-2xl font-bold mb-4 text-gray-800">Office Attendance</h1>
			<div id="status-message" class="mb-4 text-gray-600 text-sm min-h-[3rem] flex items-center justify-center">Ensure you are connected to the office Wi-Fi and allow location access.</div>
			
			<form id="attendance-form" hx-post="/api/log" hx-target="#status-message" class="hidden">
				<input type="hidden" name="auth_nonce" value="${nonce}">
				<input type="hidden" name="latitude" id="lat">
				<input type="hidden" name="longitude" id="lon">
				<input type="hidden" name="action_type" id="action_type">
			</form>
			
			<div class="w-full mt-2">
				${actionButtonsHTML}
			</div>
			
			${exceptionSectionHTML}
		`;
	}

	return `
	<!DOCTYPE html>
	<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
		<title>Office Attendance</title>
		<script src="https://unpkg.com/htmx.org@1.9.10"></script>
		<script src="https://cdn.tailwindcss.com"></script>
		<script>
			function logLocation(action) {
				const statusMsg = document.getElementById('status-message');
				document.getElementById('action_type').value = action;
				statusMsg.innerHTML = '<span class="text-blue-600 font-semibold animate-pulse">Acquiring GPS lock...</span>';
				if (!navigator.geolocation) return statusMsg.innerHTML = '<span class="text-red-600 font-bold">Geolocation not supported.</span>';
				
				navigator.geolocation.getCurrentPosition(
					(position) => {
						document.getElementById('lat').value = position.coords.latitude;
						document.getElementById('lon').value = position.coords.longitude;
						htmx.trigger('#attendance-form', 'submit');
					},
					(error) => statusMsg.innerHTML = '<span class="text-red-600 font-bold text-sm">Location access denied or unavailable.</span>',
					{ enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
				);
			}
		</script>
	</head>
	<body class="bg-gray-100 flex items-center justify-center min-h-screen">
		<div id="form-container" class="bg-white p-8 rounded-xl shadow-md w-96 text-center mx-4 my-8">
			${viewState === 'register' ? registerForm : attendanceForm}
		</div>
	</body>
	</html>
	`;
}