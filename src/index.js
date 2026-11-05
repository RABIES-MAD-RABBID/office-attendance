import { handleAdmin } from './admin.js';

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		if (url.pathname.startsWith("/admin")) return await handleAdmin(request, env, url);

		const db = env.office_attendance_db;

		if (url.pathname === "/api/my-ip") {
			return new Response(request.headers.get("CF-Connecting-IP") || "Local_Test_IP");
		}

		if (url.pathname === "/manifest.json") {
			return new Response(JSON.stringify({
				name: "Attendance", start_url: "/", display: "standalone", theme_color: "#2563eb",
				icons: [{ src: "https://upload.wikimedia.org/wikipedia/commons/4/4e/Building_icon.svg", sizes: "512x512", type: "image/svg+xml" }]
			}), { headers: { "Content-Type": "application/json" } });
		}

		const cookieHeader = request.headers.get("Cookie") || "";
		const tokenMatch = cookieHeader.match(/device_token=([^;]+)/);
		const deviceToken = tokenMatch ? tokenMatch[1] : null;

		// --- GET ROOT: UI & State Handling ---
		if (url.pathname === "/" && request.method === "GET") {
			const nonce = crypto.randomUUID();
			await db.prepare("INSERT INTO auth_nonces (nonce) VALUES (?)").bind(nonce).run();
			
			let viewState = 'register';
			let hasSignedInToday = false;
			let activeException = null; // New variable to track active leave/workshops
			
			if (deviceToken) {
				const activeEmp = await db.prepare("SELECT * FROM employees WHERE device_token = ? AND status = 'active'").bind(deviceToken).first();
				if (activeEmp) {
					viewState = 'attendance';
					
					const existingLog = await db.prepare(`
						SELECT * FROM attendance_logs 
						WHERE emp_number = ? AND action_type = 'SIGN_IN' AND verified = 1
						AND date(timestamp, '+3 hours') = date('now', '+3 hours')
					`).bind(activeEmp.emp_number).first();
					
					if (existingLog) hasSignedInToday = true;

					// Check if there is an ongoing exception for the current EAT date
					activeException = await db.prepare(`
						SELECT * FROM status_exceptions
						WHERE emp_number = ? 
						AND date('now', '+3 hours') >= start_date 
						AND date('now', '+3 hours') <= end_date
					`).bind(activeEmp.emp_number).first();
				}
			}

			// Pass activeException to the HTML generator
			const response = new Response(getAppHTML(viewState, nonce, hasSignedInToday, activeException), {
				headers: { "Content-Type": "text/html;charset=UTF-8" },
			});

			if (deviceToken && viewState === 'register') {
				response.headers.append("Set-Cookie", "device_token=; HttpOnly; Secure; Path=/; Max-Age=0");
			}

			return response;
		}

		// --- POST REGISTER ---
		if (url.pathname === "/api/register" && request.method === "POST") {
			const formData = await request.formData();
			const fullName = `${formData.get("first_name")} ${formData.get("last_name")}`.trim();
			const division = formData.get("division");
			
			const existing = await db.prepare("SELECT * FROM employees WHERE LOWER(full_name) = LOWER(?)").bind(fullName).first();
			
			if (existing) {
				if (existing.status === 'terminated') {
					const newToken = crypto.randomUUID();
					await db.prepare("UPDATE employees SET device_token = ?, status = 'active', division = ? WHERE emp_number = ?").bind(newToken, division, existing.emp_number).run();
					return new Response(`<div class='text-green-600 font-bold mb-4'>Account reactivated!</div><a href="/" class="bg-gray-800 text-white px-4 py-2 rounded mt-4 inline-block">Continue</a>`,
						{ headers: { "Content-Type": "text/html", "Set-Cookie": `device_token=${newToken}; HttpOnly; Secure; Path=/; Max-Age=315360000` }});
				} else if (!existing.device_token) {
					const newToken = crypto.randomUUID();
					await db.prepare("UPDATE employees SET device_token = ?, division = ? WHERE emp_number = ?").bind(newToken, division, existing.emp_number).run();
					return new Response(`<div class='text-green-600 font-bold mb-4'>Device successfully re-bound!</div><a href="/" class="bg-gray-800 text-white px-4 py-2 rounded mt-4 inline-block">Continue</a>`,
						{ headers: { "Content-Type": "text/html", "Set-Cookie": `device_token=${newToken}; HttpOnly; Secure; Path=/; Max-Age=315360000` }});
				} else {
					return new Response("<span class='text-red-600 font-bold'>Error: You are already registered on an active device. Contact Admin if phone was lost.</span>", { status: 400 });
				}
			}

			const generatedEmpNumber = 'ID-' + crypto.randomUUID().split('-')[0].toUpperCase();
			const newToken = crypto.randomUUID();
			await db.prepare("INSERT INTO employees (emp_number, full_name, device_token, division) VALUES (?, ?, ?, ?)").bind(generatedEmpNumber, fullName, newToken, division).run();

			return new Response(`<div class='text-green-600 font-bold mb-4'>Device securely bound!</div><a href="/" class="bg-gray-800 text-white px-4 py-2 rounded mt-4 inline-block">Continue</a>`,
				{ headers: { "Content-Type": "text/html", "Set-Cookie": `device_token=${newToken}; HttpOnly; Secure; Path=/; Max-Age=315360000` }});
		}

		// --- POST LOG: GPS & Network Verification ---
		if (url.pathname === "/api/log" && request.method === "POST") {
			if (!deviceToken) return new Response("<span class='text-red-600 font-bold'>Unauthorized. No token found.</span>");
			const employee = await db.prepare("SELECT * FROM employees WHERE device_token = ? AND status = 'active'").bind(deviceToken).first();
			if (!employee) return new Response("<span class='text-red-600 font-bold'>Device unrecognized or account terminated.</span>");

			const formData = await request.formData();
			const submittedNonce = formData.get("auth_nonce");
			const actionType = formData.get("action_type");
			
			const eatDate = new Date(new Date().toLocaleString("en-US", {timeZone: "Africa/Nairobi"}));
			const currentHour = eatDate.getHours();

			if (actionType === 'SIGN_IN') {
				if (currentHour >= 17 || currentHour < 4) {
					return new Response("<span class='text-red-600 font-bold'>Sign-in is only allowed between 04:00 and 17:00 EAT.</span>");
				}
				const existingLog = await db.prepare(`SELECT * FROM attendance_logs WHERE emp_number = ? AND action_type = 'SIGN_IN' AND verified = 1 AND date(timestamp, '+3 hours') = date('now', '+3 hours')`).bind(employee.emp_number).first();
				if (existingLog) return new Response("<div class='text-amber-600 font-bold text-lg mb-2'>⚠️ Already Signed In</div><div class='text-gray-500 text-sm'>You have already signed in for today.</div>", { headers: { "Content-Type": "text/html" } });
			}

			if (actionType === 'SIGN_OUT') {
				if (currentHour >= 4 && currentHour < 17) {
					return new Response("<span class='text-red-600 font-bold'>Sign-out is only allowed after 17:00 EAT.</span>");
				}
			}

			const validNonce = await db.prepare("SELECT * FROM auth_nonces WHERE nonce = ? AND (julianday('now') - julianday(created_at)) * 86400 < 120").bind(submittedNonce).first();
			if (!validNonce) return new Response("<span class='text-red-600 font-bold'>Session expired or tampered. Please refresh the page.</span>");
			await db.prepare("DELETE FROM auth_nonces WHERE nonce = ?").bind(submittedNonce).run();
			await db.prepare("DELETE FROM auth_nonces WHERE (julianday('now') - julianday(created_at)) * 86400 > 300").run();

			// --- ANTI-SPAM COOLDOWN ---
			const recentLog = await db.prepare(`
				SELECT * FROM attendance_logs 
				WHERE emp_number = ? AND (julianday('now') - julianday(timestamp)) * 1440 < 2
			`).bind(employee.emp_number).first();
			
			if (recentLog) {
				return new Response(
					`<div class='text-amber-600 font-bold text-lg mb-2'>⚠️ Cooldown Active</div>
					 <div class='text-gray-500 text-sm'>Please wait 2 minutes before attempting to log again to prevent system spam.</div>`, 
					{ headers: { "Content-Type": "text/html" } }
				);
			}

			const lat = parseFloat(formData.get("latitude"));
			const lon = parseFloat(formData.get("longitude"));
			const ipAddress = request.headers.get("CF-Connecting-IP") || "Local_Test_IP";

			const locations = await db.prepare("SELECT * FROM office_locations").all();
			let verified = 0;
			let closestDistance = Infinity;
			let activeLocationName = "Unknown";
			let flagReason = "Location/Network mismatch";

			for (const loc of locations.results) {
				const dist = calculateDistance(lat, lon, loc.latitude, loc.longitude);
				if (dist < closestDistance) closestDistance = dist;
				
				const allowedIpsArray = loc.allowed_ips.split(',').map(ip => ip.trim());
				if (dist <= loc.radius_meters && (allowedIpsArray.includes(ipAddress) || ipAddress === "Local_Test_IP")) {
					verified = 1;
					flagReason = null;
					activeLocationName = loc.name;
					break; 
				}
			}

			if (verified === 0) flagReason = `GPS: ${Math.round(closestDistance)}m from nearest office | IP: ${ipAddress}`;

			await db.prepare(
				"INSERT INTO attendance_logs (emp_number, action_type, ip_address, latitude, longitude, distance_meters, verified, flag_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
			).bind(employee.emp_number, actionType, ipAddress, lat, lon, closestDistance, verified, flagReason).run();

			const actionText = actionType === 'SIGN_IN' ? 'Signed in' : 'Signed out';

			if (verified === 1) {
				return new Response(`<div class='text-green-600 font-bold text-lg mb-2'>✅ ${actionText} successfully!</div><div class='text-gray-500 text-sm'>${employee.full_name} at ${activeLocationName}</div>`, { headers: { "Content-Type": "text/html" } });
			} else {
				return new Response(`<div class='text-amber-600 font-bold text-lg mb-2'>⚠️ ${actionText} Flagged</div><div class='text-gray-500 text-sm'>${employee.full_name}</div><div class='text-gray-600 text-xs mt-2'>Failed checks: ${flagReason}. Logged for review.</div>`, { headers: { "Content-Type": "text/html" } });
			}
		}

		if (url.pathname === "/api/exception" && request.method === "POST") {
			const formData = await request.formData();
			const employee = await db.prepare("SELECT * FROM employees WHERE device_token = ? AND status = 'active'").bind(deviceToken).first();
			if (!employee) return new Response("<span class='text-red-600 font-bold'>Account inactive.</span>");
			await db.prepare("INSERT INTO status_exceptions (emp_number, type, start_date, end_date, description, notified_person) VALUES (?, ?, ?, ?, ?, ?)").bind(employee.emp_number, formData.get("type"), formData.get("start_date"), formData.get("end_date"), formData.get("description") || null, formData.get("notified_person") || null).run();
			return new Response(`<div class='text-blue-600 font-bold'>✅ Logged!</div><button onclick="location.reload()" class="mt-2 text-sm text-blue-500 underline">Refresh</button>`, { headers: { "Content-Type": "text/html" } });
		}

		return new Response("Not Found", { status: 404 });
	},

	// --- AUTOMATED DATA SCRUBBER (CRON JOB) ---
	async scheduled(event, env, ctx) {
		const db = env.office_attendance_db;
		
		// Retain data for 1 full year (365 days)
		await db.prepare(`DELETE FROM attendance_logs WHERE (julianday('now') - julianday(timestamp)) > 365`).run();
		await db.prepare(`DELETE FROM status_exceptions WHERE (julianday('now') - julianday(created_at)) > 365`).run();
		await db.prepare(`DELETE FROM admin_audit_logs WHERE (julianday('now') - julianday(timestamp)) > 365`).run();
		
		console.log("365-day data scrub executed successfully.");
	}
};

function calculateDistance(lat1, lon1, lat2, lon2) {
	const R = 6371e3; 
	const φ1 = lat1 * Math.PI / 180;
	const φ2 = lat2 * Math.PI / 180;
	const Δφ = (lat2 - lat1) * Math.PI / 180;
	const Δλ = (lon2 - lon1) * Math.PI / 180;
	const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
	return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function getAppHTML(viewState, nonce, hasSignedInToday = false, activeException = null) {
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

	// IF EXCEPTION IS ACTIVE: Render locked UI
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
		// IF NO EXCEPTION: Render standard logging UI
		const eatDate = new Date(new Date().toLocaleString("en-US", {timeZone: "Africa/Nairobi"}));
		const hour = eatDate.getHours();
		
		const canSignIn = hour >= 4 && hour < 17;
		const canSignOut = hour >= 17 || hour < 4;

		let actionButtonsHTML = '';
		let statusHintHTML = '';

		if (canSignIn) {
			if (hasSignedInToday) {
				actionButtonsHTML = `<div class="w-full bg-gray-100 text-gray-500 px-2 py-4 rounded-lg font-bold shadow-inner border text-center">Already Signed In Today</div>`;
				statusHintHTML = `<p class="text-xs text-gray-500 mt-3 text-center">Sign-out will become available at 17:00 EAT.</p>`;
			} else {
				actionButtonsHTML = `<button onclick="logLocation('SIGN_IN')" class="bg-green-600 text-white px-2 py-4 rounded-lg font-bold hover:bg-green-700 w-full shadow-lg transition-transform active:scale-95">SIGN IN</button>`;
			}
		} else if (canSignOut) {
			actionButtonsHTML = `<button onclick="logLocation('SIGN_OUT')" class="bg-red-600 text-white px-2 py-4 rounded-lg font-bold hover:bg-red-700 w-full shadow-lg transition-transform active:scale-95">SIGN OUT</button>`;
			statusHintHTML = `<p class="text-xs text-gray-500 mt-3 text-center">Sign-in for the next shift becomes available at 04:00 EAT.</p>`;
		}

		attendanceForm = `
			<h1 class="text-2xl font-bold mb-4 text-gray-800">Office Attendance</h1>
			<div id="status-message" class="mb-4 text-gray-600 text-sm h-12 flex items-center justify-center">Ensure you are connected to the office Wi-Fi and allow location access.</div>
			
			<form id="attendance-form" hx-post="/api/log" hx-target="#status-message" class="hidden">
				<input type="hidden" name="auth_nonce" value="${nonce}">
				<input type="hidden" name="latitude" id="lat">
				<input type="hidden" name="longitude" id="lon">
				<input type="hidden" name="action_type" id="action_type">
			</form>
			
			<div class="w-full mt-2">
				${actionButtonsHTML}
			</div>
			${statusHintHTML}
			
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
					<button type="submit" class="bg-blue-600 text-white px-4 py-2 rounded-lg font-semibold w-full text-sm mt-2">Submit Status</button>
				</form>
			</div>
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