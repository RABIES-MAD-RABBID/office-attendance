export async function handleAdmin(request, env, url) {
	const db = env.office_attendance_db;

	const expectedAuth = 'Basic YWRtaW46SW5mcmFBZG1pbjIwMjYh';
	const authHeader = request.headers.get("Authorization");
	if (authHeader !== expectedAuth) {
		return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Admin Dashboard"' }});
	}

	if (url.pathname === "/admin" && request.method === "GET") {
		const locations = await db.prepare("SELECT * FROM office_locations").all();
		const employees = await db.prepare("SELECT * FROM employees ORDER BY status ASC, division, full_name").all();
		const auditLogs = await db.prepare("SELECT * FROM admin_audit_logs ORDER BY timestamp DESC LIMIT 30").all();
		const logs = await db.prepare(`SELECT l.*, e.full_name, e.division FROM attendance_logs l JOIN employees e ON l.emp_number = e.emp_number ORDER BY l.timestamp DESC LIMIT 150`).all();
		const exceptions = await db.prepare("SELECT * FROM status_exceptions").all();

		return new Response(getAdminHTML(locations.results, logs.results, employees.results, exceptions.results, auditLogs.results), {
			headers: { 
				"Content-Type": "text/html;charset=UTF-8",
				"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"
			},
		});
	}

	// --- 1. TIME-TRAVEL CALENDAR ---
	if (url.pathname === "/admin/calendar" && request.method === "GET") {
		const empNumber = url.searchParams.get("emp_number");
		const employee = await db.prepare("SELECT * FROM employees WHERE emp_number = ?").bind(empNumber).first();
		if (!employee) return new Response("<p class='text-red-500'>Employee not found</p>");

		const eatDate = new Date(new Date().toLocaleString("en-US", {timeZone: "Africa/Nairobi"}));
		
		let targetYear = parseInt(url.searchParams.get("year")) || eatDate.getFullYear();
		let targetMonth = parseInt(url.searchParams.get("month"));
		if (isNaN(targetMonth)) targetMonth = eatDate.getMonth();

		let prevM = targetMonth - 1; let prevY = targetYear;
		if (prevM < 0) { prevM = 11; prevY--; }
		
		let nextM = targetMonth + 1; let nextY = targetYear;
		if (nextM > 11) { nextM = 0; nextY++; }

		const displayDate = new Date(targetYear, targetMonth, 1);
		const monthName = displayDate.toLocaleString('default', { month: 'long', year: 'numeric' });

		const empLogs = await db.prepare(`SELECT * FROM attendance_logs WHERE emp_number = ? AND action_type = 'SIGN_IN' AND verified = 1`).bind(empNumber).all();
		const empExceptions = await db.prepare(`SELECT * FROM status_exceptions WHERE emp_number = ?`).bind(empNumber).all();

		const firstDay = new Date(targetYear, targetMonth, 1).getDay(); 
		const daysInMonth = new Date(targetYear, targetMonth + 1, 0).getDate();

		let gridHTML = `
			<div class="flex justify-between items-center mb-6">
				<h2 class="text-2xl font-bold text-gray-800">${employee.full_name} <span class="text-lg font-normal text-gray-500">| ${monthName}</span></h2>
				<div class="flex gap-2">
					<button hx-get="/admin/calendar?emp_number=${empNumber}&year=${prevY}&month=${prevM}" hx-target="#modal-content" class="px-3 py-1 bg-gray-200 hover:bg-gray-300 rounded text-sm font-bold transition-colors">&larr; Prev</button>
					<button hx-get="/admin/calendar?emp_number=${empNumber}&year=${nextY}&month=${nextM}" hx-target="#modal-content" class="px-3 py-1 bg-gray-200 hover:bg-gray-300 rounded text-sm font-bold transition-colors">Next &rarr;</button>
				</div>
			</div>
			<div class="grid grid-cols-7 gap-2 text-center font-bold text-sm text-gray-600 mb-2">
				<div>Sun</div><div>Mon</div><div>Tue</div><div>Wed</div><div>Thu</div><div>Fri</div><div>Sat</div>
			</div>
			<div class="grid grid-cols-7 gap-2">
		`;

		for (let i = 0; i < firstDay; i++) gridHTML += `<div class="p-4 bg-gray-50 rounded-lg border border-transparent"></div>`;

		for (let d = 1; d <= daysInMonth; d++) {
			const currentDate = new Date(targetYear, targetMonth, d);
			const dateStr = `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
			const isWeekend = currentDate.getDay() === 0 || currentDate.getDay() === 6;
			const isFuture = currentDate > eatDate;

			let bgColor = isWeekend ? 'bg-gray-100 text-gray-400 border-transparent' : (isFuture ? 'bg-white border-gray-200 text-gray-400' : 'bg-red-50 text-red-800 border-red-200');
			let label = isWeekend ? 'Weekend' : (isFuture ? '-' : 'Absent');

			const ex = empExceptions.results.find(e => e.start_date <= dateStr && e.end_date >= dateStr);
			if (ex) {
				if (ex.type === 'Workshop/Inspection') { bgColor = 'bg-blue-50 text-blue-800 border-blue-200'; label = 'Workshop'; }
				else if (ex.type === 'Sick Leave') { bgColor = 'bg-pink-50 text-pink-800 border-pink-200'; label = 'Sick Leave'; }
				else if (ex.type === 'Annual Leave') { bgColor = 'bg-yellow-50 text-yellow-800 border-yellow-200'; label = 'Leave'; }
			} else if (!isFuture && !isWeekend) {
				const log = empLogs.results.find(l => {
					const lDate = new Date(new Date(l.timestamp + 'Z').toLocaleString("en-US", {timeZone: "Africa/Nairobi"}));
					return `${lDate.getFullYear()}-${String(lDate.getMonth() + 1).padStart(2, '0')}-${String(lDate.getDate()).padStart(2, '0')}` === dateStr;
				});
				if (log) {
					bgColor = 'bg-green-50 text-green-800 border-green-200 shadow-sm';
					label = new Date(log.timestamp + 'Z').toLocaleTimeString("en-US", {timeZone: "Africa/Nairobi", hour: '2-digit', minute:'2-digit'});
				}
			}

			gridHTML += `<div class="p-2 border rounded-lg flex flex-col items-center justify-center h-24 ${bgColor}"><span class="font-bold text-lg leading-none mb-1">${d}</span><span class="text-xs font-semibold truncate w-full text-center block px-1">${label}</span></div>`;
		}

		const totalCells = firstDay + daysInMonth;
		const remaining = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
		for (let i = 0; i < remaining; i++) gridHTML += `<div class="p-4 bg-gray-50 rounded-lg border border-transparent"></div>`;

		gridHTML += `</div>`;
		return new Response(gridHTML, { headers: { "Content-Type": "text/html" } });
	}

	// --- 2. DATE RANGE EXPORT ENGINE ---
	if (url.pathname === "/admin/export" && request.method === "GET") {
		const filterTarget = url.searchParams.get("target") || "ALL";
		
		const eatDate = new Date(new Date().toLocaleString("en-US", {timeZone: "Africa/Nairobi"}));
		const todayStr = `${eatDate.getFullYear()}-${String(eatDate.getMonth() + 1).padStart(2, '0')}-${String(eatDate.getDate()).padStart(2, '0')}`;
		
		const startDateStr = url.searchParams.get("start_date") || todayStr;
		const endDateStr = url.searchParams.get("end_date") || todayStr;

		let employees;
		let filenameTarget = "Report";

		if (filterTarget === "ALL") {
			employees = await db.prepare("SELECT * FROM employees WHERE status = 'active' ORDER BY division, full_name").all();
			filenameTarget = "All_Divisions";
		} else if (filterTarget.startsWith("DIV:")) {
			const divName = filterTarget.replace("DIV:", "");
			employees = await db.prepare("SELECT * FROM employees WHERE status = 'active' AND division = ? ORDER BY full_name").bind(divName).all();
			filenameTarget = divName.replace(/\s+/g, '_');
		} else {
			employees = await db.prepare("SELECT * FROM employees WHERE emp_number = ?").bind(filterTarget).all();
			filenameTarget = employees.results[0].full_name.replace(/\s+/g, '_');
		}

		const cleanLogs = await db.prepare(`
			SELECT emp_number, date(timestamp, '+3 hours') as log_date, 
				MIN(CASE WHEN action_type = 'SIGN_IN' THEN time(timestamp, '+3 hours') END) as sign_in_time,
				MAX(CASE WHEN action_type = 'SIGN_OUT' THEN time(timestamp, '+3 hours') END) as sign_out_time
			FROM attendance_logs WHERE verified = 1 GROUP BY emp_number, log_date
		`).all();

		const exceptions = await db.prepare("SELECT * FROM status_exceptions").all();

		const workingDays = [];
		const start = new Date(startDateStr);
		const end = new Date(endDateStr);
		
		for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
			if (d.getDay() !== 0 && d.getDay() !== 6) { 
				workingDays.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`);
			}
		}

		let csvContent = "Date,Employee Name,Division,Status,First Sign-In,Last Sign-Out,Exception Details\n";

		employees.results.forEach(emp => {
			workingDays.forEach(dStr => {
				const empEx = exceptions.results.find(ex => ex.emp_number === emp.emp_number && ex.start_date <= dStr && ex.end_date >= dStr);
				const empLog = cleanLogs.results.find(l => l.emp_number === emp.emp_number && l.log_date === dStr);
				
				let status = "Absent";
				let signIn = "-";
				let signOut = "-";
				let details = "-";
				
				if (empEx) {
					status = empEx.type;
					details = empEx.description || `Notified: ${empEx.notified_person}`;
				} else if (empLog) {
					status = "Present";
					signIn = empLog.sign_in_time || "-";
					signOut = empLog.sign_out_time || "-";
				}

				if (dStr <= todayStr) {
					csvContent += `"${dStr}","${emp.full_name}","${emp.division || 'Unassigned'}","${status}","${signIn}","${signOut}","${details}"\n`;
				}
			});
		});

		return new Response(csvContent, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="Attendance_${filenameTarget}_${startDateStr}_to_${endDateStr}.csv"` } });
	}

	// --- 3. ADD/EDIT LOCATION WITH VALIDATION ---
	if (url.pathname === "/admin/location" && request.method === "POST") {
		const formData = await request.formData();
		const id = formData.get("loc_id");
		const name = formData.get("name").trim();
		const lat = parseFloat(formData.get("latitude"));
		const lon = parseFloat(formData.get("longitude"));
		const radius = parseInt(formData.get("radius"));
		const allowedIps = formData.get("allowed_ips").trim();

		if (radius > 100) {
			return new Response("<span class='text-red-600 font-bold block mb-2'>Error: Radius cannot exceed 100 meters.</span>", { status: 400 });
		}

		if (id) {
			const existing = await db.prepare("SELECT * FROM office_locations WHERE (name = ? OR (latitude = ? AND longitude = ?)) AND id != ?").bind(name, lat, lon, id).first();
			if (existing) return new Response(`<span class='text-red-600 font-bold block mb-2'>Error: Location "${name}" or these exact coordinates already exist.</span>`, { status: 400 });
			
			await db.prepare("UPDATE office_locations SET name = ?, latitude = ?, longitude = ?, radius_meters = ?, allowed_ips = ? WHERE id = ?").bind(name, lat, lon, radius, allowedIps, id).run();
			await db.prepare("INSERT INTO admin_audit_logs (action, target_employee, details) VALUES (?, ?, ?)").bind("EDIT_LOCATION", "SYSTEM", `Edited office: ${name}`).run();
		} else {
			const existing = await db.prepare("SELECT * FROM office_locations WHERE name = ? OR (latitude = ? AND longitude = ?)").bind(name, lat, lon).first();
			if (existing) return new Response(`<span class='text-red-600 font-bold block mb-2'>Error: Location "${name}" or these exact coordinates already exist.</span>`, { status: 400 });
			
			await db.prepare("INSERT INTO office_locations (name, latitude, longitude, radius_meters, allowed_ips) VALUES (?, ?, ?, ?, ?)").bind(name, lat, lon, radius, allowedIps).run();
			await db.prepare("INSERT INTO admin_audit_logs (action, target_employee, details) VALUES (?, ?, ?)").bind("ADD_LOCATION", "SYSTEM", `Added office: ${name}`).run();
		}

		return new Response("<span class='text-green-600 font-bold'>Saved successfully. Refreshing...</span>", { headers: { "Content-Type": "text/html", "HX-Refresh": "true" }});
	}

	if (url.pathname === "/admin/location/delete" && request.method === "POST") {
		const formData = await request.formData();
		await db.prepare("DELETE FROM office_locations WHERE id = ?").bind(formData.get("id")).run();
		await db.prepare("INSERT INTO admin_audit_logs (action, target_employee, details) VALUES (?, ?, ?)").bind("DELETE_LOCATION", "SYSTEM", `Deleted office: ${formData.get("name")}`).run();
		return new Response("", { headers: { "HX-Refresh": "true" }});
	}

	if (url.pathname === "/admin/detach" && request.method === "POST") {
		const formData = await request.formData();
		await db.prepare("UPDATE employees SET device_token = NULL WHERE emp_number = ?").bind(formData.get("emp_number")).run();
		await db.prepare("INSERT INTO admin_audit_logs (action, target_employee, details) VALUES (?, ?, ?)").bind("DETACH", formData.get("emp_name"), "Device token manually detached.").run();
		return new Response("", { headers: { "HX-Refresh": "true" }});
	}

	if (url.pathname === "/admin/terminate" && request.method === "POST") {
		const formData = await request.formData();
		await db.prepare("UPDATE employees SET device_token = NULL, status = 'terminated' WHERE emp_number = ?").bind(formData.get("emp_number")).run();
		await db.prepare("INSERT INTO admin_audit_logs (action, target_employee, details) VALUES (?, ?, ?)").bind("TERMINATE", formData.get("emp_name"), "Account terminated.").run();
		return new Response("", { headers: { "HX-Refresh": "true" }});
	}

	return new Response("Admin Route Not Found", { status: 404 });
}

function getAdminHTML(locations, logs, employees, exceptions, auditLogs) {
	const eatDate = new Date(new Date().toLocaleString("en-US", {timeZone: "Africa/Nairobi"}));
	const todayStr = `${eatDate.getFullYear()}-${String(eatDate.getMonth() + 1).padStart(2, '0')}-${String(eatDate.getDate()).padStart(2, '0')}`;
	const monthName = eatDate.toLocaleString('default', { month: 'long', year: 'numeric' });
	const daysInMonth = new Date(eatDate.getFullYear(), eatDate.getMonth() + 1, 0).getDate();

	const todaysLogs = logs.filter(l => {
		const lDate = new Date(new Date(l.timestamp + 'Z').toLocaleString("en-US", {timeZone: "Africa/Nairobi"}));
		const lStr = `${lDate.getFullYear()}-${String(lDate.getMonth() + 1).padStart(2, '0')}-${String(lDate.getDate()).padStart(2, '0')}`;
		return lStr === todayStr;
	});

	const dailyRowsHTML = todaysLogs.map(log => `
		<tr class="border-b hover:bg-gray-50 text-sm">
			<td class="p-3">${new Date(log.timestamp + 'Z').toLocaleTimeString("en-US", {timeZone: "Africa/Nairobi"})}</td>
			<td class="p-3 font-semibold">${log.full_name} <span class="text-xs text-gray-500 block">${log.division || 'Unassigned'}</span></td>
			<td class="p-3 font-medium ${log.action_type === 'SIGN_IN' ? 'text-green-600' : 'text-blue-600'}">${log.action_type}</td>
			<td class="p-3">${log.verified ? '<span class="px-2 py-1 bg-green-100 text-green-800 rounded text-xs font-bold">Valid</span>' : '<span class="px-2 py-1 bg-amber-100 text-amber-800 rounded text-xs font-bold">Flagged</span>'}</td>
			<td class="p-3 text-xs text-gray-500 truncate max-w-xs" title="${log.flag_reason || 'Perfect match'}">${log.flag_reason || 'Perfect match'}</td>
		</tr>
	`).join('');

	const divisions = {};
	const uniqueDivisions = new Set();
	
	employees.forEach(emp => {
		if (emp.status === 'terminated') return; 
		const div = emp.division || 'Unassigned';
		uniqueDivisions.add(div);
		if (!divisions[div]) divisions[div] = [];
		divisions[div].push(emp);
	});

	let calendarHTML = '';
	for (const [divName, emps] of Object.entries(divisions)) {
		calendarHTML += `
		<details class="mb-4 bg-white shadow rounded-lg border border-gray-200" open>
			<summary class="font-bold p-4 cursor-pointer bg-gray-50 rounded-t-lg border-b hover:bg-gray-100">
				${divName} <span class="text-gray-500 font-normal text-sm ml-2">(${emps.length})</span>
			</summary>
			<div class="p-4 overflow-x-auto"><table class="w-full text-sm text-center border-collapse"><thead><tr class="text-gray-600"><th class="p-2 text-left w-48">Employee</th>`;
		for(let d=1; d<=daysInMonth; d++) calendarHTML += `<th class="p-1 font-medium w-8">${d}</th>`;
		calendarHTML += `</tr></thead><tbody>`;

		emps.forEach(emp => {
			calendarHTML += `<tr class="border-t">
				<td class="p-2 text-left font-medium whitespace-nowrap">
					<button hx-get="/admin/calendar?emp_number=${emp.emp_number}" hx-target="#modal-content" onclick="document.getElementById('calendar-modal').classList.remove('hidden')" class="text-blue-600 hover:text-blue-800 hover:underline font-semibold focus:outline-none transition-colors">
						${emp.full_name}
					</button>
				</td>`;
			for (let d = 1; d <= daysInMonth; d++) {
				const currentDate = new Date(eatDate.getFullYear(), eatDate.getMonth(), d);
				const dateStr = `${eatDate.getFullYear()}-${String(eatDate.getMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
				const isWeekend = currentDate.getDay() === 0 || currentDate.getDay() === 6;
				const isFuture = currentDate > eatDate;
				
				let bgColor = isWeekend ? 'bg-gray-200' : (isFuture ? 'bg-gray-50' : 'bg-red-500'); 
				let tooltip = isWeekend ? 'Weekend' : (isFuture ? 'Future Date' : 'Unattended');
				
				const empExceptions = exceptions.filter(ex => ex.emp_number === emp.emp_number && ex.start_date <= dateStr && ex.end_date >= dateStr);
				
				if (empExceptions.length > 0) {
					const ex = empExceptions[0];
					if (ex.type === 'Workshop/Inspection') { bgColor = 'bg-blue-400'; tooltip = `Workshop: ${ex.description}`; } 
					else if (ex.type === 'Sick Leave') { bgColor = 'bg-pink-400'; tooltip = `Sick Leave (Notified: ${ex.notified_person})`; } 
					else if (ex.type === 'Annual Leave') { bgColor = 'bg-yellow-400'; tooltip = `Leave (Notified: ${ex.notified_person})`; }
				} else if (!isFuture && !isWeekend) {
					const empLogs = logs.filter(l => {
						if (l.emp_number !== emp.emp_number || l.action_type !== 'SIGN_IN' || l.verified !== 1) return false;
						const lDate = new Date(new Date(l.timestamp + 'Z').toLocaleString("en-US", {timeZone: "Africa/Nairobi"}));
						const lStr = `${lDate.getFullYear()}-${String(lDate.getMonth() + 1).padStart(2, '0')}-${String(lDate.getDate()).padStart(2, '0')}`;
						return lStr === dateStr;
					});
					if (empLogs.length > 0) { bgColor = 'bg-green-500'; tooltip = 'Attended'; }
				}
				calendarHTML += `<td class="border-x border-gray-100 ${bgColor} cursor-help hover:opacity-75" title="${tooltip}"></td>`;
			}
			calendarHTML += `</tr>`;
		});
		calendarHTML += `</tbody></table></div></details>`;
	}

	const employeeRowsHTML = employees.map(emp => `
		<tr class="border-b ${emp.status === 'terminated' ? 'bg-red-50 opacity-75' : ''} text-sm">
			<td class="p-3 font-semibold whitespace-nowrap">${emp.full_name} <span class="text-xs font-normal text-gray-500 block">${emp.division || 'Unassigned'} | ${emp.status.toUpperCase()}</span></td>
			<td class="p-3 text-xs font-mono">${emp.emp_number}</td>
			<td class="p-3 flex gap-2">
				${emp.status === 'active' ? `
					${emp.device_token ? 
						`<button hx-post="/admin/detach" hx-vals='{"emp_number": "${emp.emp_number}", "emp_name": "${emp.full_name.replace(/'/g, "\\'")}"}' class="bg-amber-500 text-white px-2 py-1 rounded text-xs font-bold hover:bg-amber-600 transition-colors">Detach</button>` 
					: 
						`<span class="bg-gray-200 text-gray-500 px-2 py-1 rounded text-xs font-bold cursor-not-allowed border border-gray-300">Detached</span>`
					}
					<button hx-post="/admin/terminate" hx-vals='{"emp_number": "${emp.emp_number}", "emp_name": "${emp.full_name.replace(/'/g, "\\'")}"}' hx-confirm="Terminate ${emp.full_name}?" class="bg-red-600 text-white px-2 py-1 rounded text-xs font-bold hover:bg-red-700 transition-colors">Terminate</button>
				` : `<span class="text-red-500 text-xs font-bold">Terminated</span>`}
			</td>
		</tr>
	`).join('');
	const auditRowsHTML = auditLogs.map(log => `
		<tr class="border-b text-sm">
			<td class="p-2 whitespace-nowrap">${new Date(log.timestamp + 'Z').toLocaleString("en-US", {timeZone: "Africa/Nairobi"})}</td>
			<td class="p-2 font-bold">${log.action}</td>
			<td class="p-2 whitespace-nowrap">${log.target_employee}</td>
			<td class="p-2 text-gray-600 min-w-[200px]">${log.details}</td>
		</tr>
	`).join('');

	const locationRows = locations.map(loc => `
		<div class="bg-gray-50 p-4 rounded border text-sm mb-3">
			<div class="flex justify-between items-start gap-2">
				<div class="overflow-hidden">
					<strong class="text-base truncate block">${loc.name}</strong>
					<span class="text-xs text-gray-500 block mt-1">Radius: ${loc.radius_meters}m</span>
					<span class="text-xs text-gray-500 block">GPS: ${loc.latitude}, ${loc.longitude}</span>
					<span class="text-xs text-gray-500 block truncate" title="${loc.allowed_ips}">IP: ${loc.allowed_ips}</span>
				</div>
				<div class="flex flex-col gap-2 shrink-0">
					<button onclick="editLocation('${loc.id}', '${loc.name.replace(/'/g, "\\'")}', ${loc.latitude}, ${loc.longitude}, ${loc.radius_meters}, '${loc.allowed_ips}')" class="bg-blue-100 text-blue-600 px-3 py-1 rounded text-xs font-bold hover:bg-blue-200 transition-colors">Edit</button>
					<button hx-post="/admin/location/delete" hx-vals='{"id": "${loc.id}", "name": "${loc.name.replace(/'/g, "\\'")}"}' hx-confirm="Are you sure you want to delete ${loc.name}?" class="bg-red-100 text-red-600 px-3 py-1 rounded text-xs font-bold hover:bg-red-200 transition-colors">Delete</button>
				</div>
			</div>
		</div>
	`).join('');

	return `
	<!DOCTYPE html>
	<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
		<title>HR Admin Dashboard</title>
		<script src="https://unpkg.com/htmx.org@1.9.10"></script>
		<script src="https://cdn.tailwindcss.com"></script>
		<style>
			details > summary { list-style: none; }
			details > summary::-webkit-details-marker { display: none; }
			.nav-btn.active { background-color: #1f2937; color: #fff; border-left: 4px solid #3b82f6; }
			.view-section { display: none; }
			.view-section.active { display: block; }
		</style>
		<script>
			function switchTab(tabId) {
				document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));
				document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));
				document.getElementById(tabId).classList.add('active');
				document.getElementById('btn-' + tabId).classList.add('active');
				
				// Save the currently active tab to the browser's local memory
				localStorage.setItem('activeAdminTab', tabId);
				
				toggleMobileMenu(true);
			}

			// When the page reloads, automatically jump back to the saved tab
			document.addEventListener("DOMContentLoaded", () => {
				const savedTab = localStorage.getItem('activeAdminTab');
				if (savedTab && document.getElementById(savedTab)) {
					switchTab(savedTab);
				}
			});

			function toggleMobileMenu(forceClose = false) {
				const sidebar = document.getElementById('sidebar');
				if (forceClose) {
					sidebar.classList.add('-translate-x-full');
				} else {
					sidebar.classList.toggle('-translate-x-full');
				}
			}
			async function autoGatherNetwork() {
				// Detect if the user is on a mobile device
				const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
				
				if (!isMobile) {
					alert("Action Blocked: Please log into the Admin Dashboard using a smartphone to use Auto-Gather. Laptops use Wi-Fi triangulation which causes severe GPS drift and corrupts the geofence boundaries.");
					return;
				}

				const btn = document.getElementById('gather-btn');
				btn.innerText = "Gathering...";
				
				try { 
					const rawIp = await (await fetch('/api/my-ip')).text();
					const wildcardIp = rawIp.includes('.') ? rawIp.split('.').slice(0, 3).join('.') + '.*' : rawIp;
					document.getElementById('loc_ip').value = wildcardIp; 
				} catch(e) {}
				
				if (navigator.geolocation) {
					navigator.geolocation.getCurrentPosition(pos => {
						document.getElementById('loc_lat').value = pos.coords.latitude;
						document.getElementById('loc_lon').value = pos.coords.longitude;
						btn.innerText = "Auto-Gather Complete!";
						setTimeout(() => btn.innerText = "Auto-Gather Current GPS & IP", 2000);
					}, () => {
						alert("GPS Permission denied.");
						btn.innerText = "Auto-Gather Current GPS & IP";
					});
				} else {
					btn.innerText = "Geolocation not supported";
				}
			}
			function editLocation(id, name, lat, lon, radius, ips) {
				document.getElementById('loc_id').value = id;
				document.getElementById('loc_name').value = name;
				document.getElementById('loc_lat').value = lat;
				document.getElementById('loc_lon').value = lon;
				document.getElementById('loc_radius').value = radius;
				document.getElementById('loc_ip').value = ips;
				
				document.getElementById('form-title').innerText = "Edit Location";
				document.getElementById('submit-btn').innerText = "Update Rule";
				document.getElementById('cancel-btn').classList.remove('hidden');
			}
			function cancelEdit() {
				document.getElementById('loc_id').value = '';
				document.getElementById('loc_name').value = '';
				document.getElementById('loc_lat').value = '';
				document.getElementById('loc_lon').value = '';
				document.getElementById('loc_radius').value = '40';
				document.getElementById('loc_ip').value = '';
				
				document.getElementById('form-title').innerText = "Add New Location";
				document.getElementById('submit-btn').innerText = "Save Rule";
				document.getElementById('cancel-btn').classList.add('hidden');
				document.getElementById('location-error-target').innerHTML = '';
			}
			document.addEventListener('keydown', function(event){
				if(event.key === "Escape") document.getElementById('calendar-modal').classList.add('hidden');
			});
		</script>
	</head>
	<body class="bg-gray-100 flex flex-col md:flex-row h-[100dvh] overflow-hidden overscroll-none">
		
		<!-- Mobile Header -->
		<div class="md:hidden bg-gray-950 text-white flex justify-between items-center p-4 z-20 shadow-md">
			<div class="font-bold text-lg tracking-tight">ICT HR Portal</div>
			<button onclick="toggleMobileMenu()" class="focus:outline-none hover:text-gray-300 transition-colors p-2">
				<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"></path></svg>
			</button>
		</div>

		<!-- Sidebar -->
		<aside id="sidebar" class="w-64 bg-gray-900 text-gray-300 flex flex-col shadow-xl z-30 fixed inset-y-0 left-0 transform -translate-x-full md:relative md:translate-x-0 transition duration-200 ease-in-out">
			<div class="p-6 bg-gray-950 border-b border-gray-800 flex justify-between items-center">
				<div>
					<h2 class="text-xl font-bold text-white tracking-tight">ICT HR Portal</h2>
					<p class="text-xs text-gray-500 mt-1">Infrastructure Division</p>
				</div>
				<button onclick="toggleMobileMenu(true)" class="md:hidden text-gray-400 hover:text-white p-1">
					<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
				</button>
			</div>
			<nav class="flex-1 py-4 space-y-1 overflow-y-auto">
				<button id="btn-view-daily" onclick="switchTab('view-daily')" class="nav-btn active w-full flex items-center text-left px-6 py-3 text-sm font-medium hover:bg-gray-800 transition-colors">Daily Overview</button>
				<button id="btn-view-heatmap" onclick="switchTab('view-heatmap')" class="nav-btn w-full flex items-center text-left px-6 py-3 text-sm font-medium hover:bg-gray-800 transition-colors">Monthly Heatmap</button>
				<button id="btn-view-security" onclick="switchTab('view-security')" class="nav-btn w-full flex items-center text-left px-6 py-3 text-sm font-medium hover:bg-gray-800 transition-colors">Personnel & Security</button>
				<button id="btn-view-settings" onclick="switchTab('view-settings')" class="nav-btn w-full flex items-center text-left px-6 py-3 text-sm font-medium hover:bg-gray-800 transition-colors">Office Locations</button>
			</nav>
			<div class="p-4 bg-gray-950 text-xs text-center border-t border-gray-800">
				Authenticated as Admin
			</div>
		</aside>

		<!-- Main Content -->
		<main class="flex-1 overflow-y-auto p-4 md:p-8 relative w-full pb-24 overscroll-contain">
			
			<div id="view-daily" class="view-section active space-y-4 md:space-y-6">
				<div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-2">
					<h1 class="text-xl md:text-2xl font-bold text-gray-800">Today's Activity</h1>
					<span class="bg-white border text-gray-600 px-3 py-1.5 md:px-4 md:py-2 rounded shadow-sm text-sm font-bold">${todayStr}</span>
				</div>

				<div class="bg-white p-4 md:p-6 rounded-xl shadow border border-gray-200">
					<h2 class="text-lg font-bold mb-3 text-gray-800">Generate HR Attendance Report</h2>
					<form action="/admin/export" method="GET" class="flex flex-col md:flex-row flex-wrap gap-4 items-end">
						<div class="w-full md:w-1/3">
							<label class="block text-gray-700 text-xs font-bold mb-2">Select Target Data</label>
							<select name="target" class="border p-2 w-full rounded bg-gray-50 text-sm">
								<optgroup label="Entire Organization">
									<option value="ALL">All Divisions & Employees</option>
								</optgroup>
								<optgroup label="By Division">
									${Array.from(uniqueDivisions).map(div => `<option value="DIV:${div}">${div} (Division Only)</option>`).join('')}
								</optgroup>
								<optgroup label="By Employee">
									${employees.filter(e => e.status === 'active').map(e => `<option value="${e.emp_number}">${e.full_name} (${e.division || 'Unassigned'})</option>`).join('')}
								</optgroup>
							</select>
						</div>
						<div class="w-full md:flex-1 md:min-w-[12rem]">
							<label class="block text-gray-700 text-xs font-bold mb-2">Start Date</label>
							<input type="date" name="start_date" value="${todayStr}" max="${todayStr}" required class="border p-2 w-full rounded bg-gray-50 text-sm">
						</div>
						<div class="w-full md:flex-1 md:min-w-[12rem]">
							<label class="block text-gray-700 text-xs font-bold mb-2">End Date</label>
							<input type="date" name="end_date" value="${todayStr}" max="${todayStr}" required class="border p-2 w-full rounded bg-gray-50 text-sm">
						</div>
						<button type="submit" class="w-full md:w-auto bg-green-600 text-white px-6 py-2 rounded shadow-sm text-sm font-bold hover:bg-green-700 transition-colors mt-2 md:mt-0">
							Download Clean CSV
						</button>
					</form>
				</div>

				<div class="bg-white rounded-xl shadow overflow-hidden">
					<div class="p-4 bg-gray-50 border-b font-bold text-gray-700 text-sm">Raw Live Feed (Today)</div>
					<div class="overflow-x-auto">
						<table class="w-full text-left whitespace-nowrap min-w-[600px]">
							<thead class="bg-gray-100 border-b"><tr class="text-gray-600"><th class="p-4">Time</th><th class="p-4">Employee</th><th class="p-4">Action</th><th class="p-4">Status</th><th class="p-4">Details</th></tr></thead>
							<tbody>${dailyRowsHTML || '<tr><td colspan="5" class="p-8 text-center text-gray-400">No activity logged today.</td></tr>'}</tbody>
						</table>
					</div>
				</div>
			</div>

			<div id="view-heatmap" class="view-section space-y-4 md:space-y-6">
				<div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-2 mb-2">
					<h1 class="text-xl md:text-2xl font-bold text-gray-800">Attendance Heatmap</h1>
					<span class="bg-white border text-gray-600 px-3 py-1.5 md:px-4 md:py-2 rounded shadow-sm text-sm font-bold">${monthName}</span>
				</div>
				<div class="flex flex-wrap gap-2 md:gap-4 text-xs font-semibold text-gray-600 bg-white p-3 md:px-4 md:py-2 rounded shadow-sm mb-4 border">
					<div class="flex items-center gap-1"><div class="w-3 h-3 bg-green-500 rounded-sm"></div> Attended</div>
					<div class="flex items-center gap-1"><div class="w-3 h-3 bg-blue-400 rounded-sm"></div> Workshop</div>
					<div class="flex items-center gap-1"><div class="w-3 h-3 bg-yellow-400 rounded-sm"></div> Leave</div>
					<div class="flex items-center gap-1"><div class="w-3 h-3 bg-pink-400 rounded-sm"></div> Sick</div>
					<div class="flex items-center gap-1"><div class="w-3 h-3 bg-red-500 rounded-sm"></div> Absent</div>
				</div>
				${calendarHTML}
			</div>

			<div id="view-security" class="view-section space-y-4 md:space-y-6">
				<h1 class="text-xl md:text-2xl font-bold text-gray-800">Personnel & Security</h1>
				<div class="grid grid-cols-1 xl:grid-cols-2 gap-6 md:gap-8">
					<div class="bg-white p-4 md:p-6 rounded-xl shadow h-96 flex flex-col">
						<h2 class="text-lg font-bold mb-4 shrink-0">Device Management</h2>
						<div class="overflow-auto flex-1">
							<table class="w-full text-left min-w-[500px]">
								<thead><tr class="bg-gray-50 border-b"><th class="p-3">Name & Div</th><th class="p-3">ID</th><th class="p-3">Action</th></tr></thead>
								<tbody>${employeeRowsHTML}</tbody>
							</table>
						</div>
					</div>
					<div class="bg-white p-4 md:p-6 rounded-xl shadow h-96 flex flex-col border-l-4 border-red-600">
						<h2 class="text-lg font-bold mb-4 text-red-800 shrink-0">Immutable Audit Ledger</h2>
						<div class="overflow-auto flex-1">
							<table class="w-full text-left min-w-[500px]">
								<thead><tr class="bg-gray-50 border-b"><th class="p-2">Time</th><th class="p-2">Action</th><th class="p-2">Target</th><th class="p-2">Details</th></tr></thead>
								<tbody>${auditRowsHTML}</tbody>
							</table>
						</div>
					</div>
				</div>
			</div>

			<div id="view-settings" class="view-section space-y-4 md:space-y-6">
				<h1 class="text-xl md:text-2xl font-bold text-gray-800">Network & Geofence Setup</h1>
				<div class="grid grid-cols-1 lg:grid-cols-2 gap-6 md:gap-8">
					<div class="bg-white p-4 md:p-6 rounded-xl shadow h-auto md:h-[32rem] overflow-y-auto">
						<h2 class="text-lg font-bold mb-4">Active Locations</h2>
						${locationRows || '<div class="text-gray-500 text-sm mt-4">No active locations set.</div>'}
					</div>
					<div class="bg-white p-4 md:p-6 rounded-xl shadow h-auto md:h-[32rem] flex flex-col">
						<h2 id="form-title" class="text-lg font-bold mb-4">Add New Location</h2>
						<button id="gather-btn" type="button" onclick="autoGatherNetwork()" class="mb-4 w-full bg-gray-800 text-white text-xs font-bold py-3 rounded shadow hover:bg-gray-700 transition-colors">
							Auto-Gather Current GPS & IP
						</button>
						<form hx-post="/admin/location" hx-target="#location-error-target" class="space-y-4 text-sm flex-1">
							<input type="hidden" name="loc_id" id="loc_id">
							<div>
								<label class="block text-gray-700 text-xs font-bold mb-1">Office Name</label>
								<input type="text" id="loc_name" name="name" placeholder="e.g. Bruce House B" required class="border p-3 w-full rounded">
							</div>
							<div class="flex flex-col sm:flex-row gap-2 sm:gap-4">
								<div class="w-full sm:w-1/2">
									<label class="block text-gray-700 text-xs font-bold mb-1">Latitude</label>
									<input type="number" step="any" id="loc_lat" name="latitude" required class="border p-3 w-full rounded bg-gray-50">
								</div>
								<div class="w-full sm:w-1/2">
									<label class="block text-gray-700 text-xs font-bold mb-1">Longitude</label>
									<input type="number" step="any" id="loc_lon" name="longitude" required class="border p-3 w-full rounded bg-gray-50">
								</div>
							</div>
							<div>
								<label class="block text-gray-700 text-xs font-bold mb-1">Geofence Radius (Meters) - Max 100</label>
								<input type="number" id="loc_radius" name="radius" value="40" max="100" required class="border p-3 w-full rounded">
							</div>
							<div>
								<label class="block text-gray-700 text-xs font-bold mb-1">Router IP (Uses * for subnet)</label>
								<input type="text" id="loc_ip" name="allowed_ips" required class="border p-3 w-full rounded bg-gray-50">
							</div>
							<div id="location-error-target"></div>
							<div class="flex gap-2 mt-2">
								<button type="submit" id="submit-btn" class="bg-blue-600 text-white px-4 py-3 rounded font-bold w-full hover:bg-blue-700 shadow">Save Rule</button>
								<button type="button" onclick="cancelEdit()" id="cancel-btn" class="hidden bg-gray-400 text-white px-4 py-3 rounded font-bold w-1/3 hover:bg-gray-500 shadow">Cancel</button>
							</div>
						</form>
					</div>
				</div>
			</div>

			<!-- MODAL CONTAINER -->
			<div id="calendar-modal" class="fixed inset-0 bg-gray-900 bg-opacity-75 hidden z-50 flex items-center justify-center transition-opacity p-4">
				<div class="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto relative">
					<button onclick="document.getElementById('calendar-modal').classList.add('hidden')" class="absolute top-4 right-5 text-gray-400 hover:text-red-500 text-3xl font-bold leading-none z-10">&times;</button>
					<div id="modal-content" class="p-4 md:p-8">
						<div class="flex justify-center items-center h-64"><span class="animate-pulse text-gray-500 font-bold">Loading Calendar...</span></div>
					</div>
				</div>
			</div>

		</main>
	</body>
	</html>
	`;
}