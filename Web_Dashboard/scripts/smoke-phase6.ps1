# Phase 6 smoke test - Devlog 2026-06-04 single-code model.
# Validates the new endpoints end-to-end before the VR side is wired.

$base = 'http://localhost:3000'

Write-Host ''
Write-Host '--- /api/tenant/resolve (5555555555 should resolve to securitas) ---' -ForegroundColor Cyan
$r = Invoke-RestMethod -Method POST -Uri "$base/api/tenant/resolve" -ContentType 'application/json' -Body '{"code":"5555555555"}'
$r | ConvertTo-Json

Write-Host ''
Write-Host '--- /api/tenant/resolve (bad code, expect 401) ---' -ForegroundColor Cyan
try {
  Invoke-RestMethod -Method POST -Uri "$base/api/tenant/resolve" -ContentType 'application/json' -Body '{"code":"9999999999"}'
} catch {
  Write-Host ('  status: ' + $_.Exception.Response.StatusCode.value__)
  Write-Host ('  body:   ' + $_.ErrorDetails.Message)
}

Write-Host ''
Write-Host '--- /api/instructor/login (5555555555, name=Jan, sets cookie) ---' -ForegroundColor Cyan
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$r2 = Invoke-WebRequest -Method POST -Uri "$base/api/instructor/login" -ContentType 'application/json' -Body '{"code":"5555555555","displayName":"Jan"}' -WebSession $session
Write-Host ('  status: ' + $r2.StatusCode)
Write-Host ('  body:   ' + $r2.Content)
$cookie = $session.Cookies.GetCookies($base) | Where-Object { $_.Name -eq 'vrip_instructor' }
if ($cookie) {
  $maxLen = [Math]::Min(40, $cookie.Value.Length)
  Write-Host ('  cookie: ' + $cookie.Value.Substring(0, $maxLen) + '...')
} else {
  Write-Host '  cookie: NOT SET (FAIL)' -ForegroundColor Red
}

Write-Host ''
Write-Host '--- /api/instructor/me (with cookie) ---' -ForegroundColor Cyan
$r3 = Invoke-RestMethod -Uri "$base/api/instructor/me" -WebSession $session
$r3 | ConvertTo-Json

Write-Host ''
Write-Host '--- /api/sessions (with cookie, tenantId comes from cookie) ---' -ForegroundColor Cyan
$r4 = Invoke-RestMethod -Uri "$base/api/sessions" -WebSession $session
$r4 | ConvertTo-Json

Write-Host ''
Write-Host '--- /api/instructor/me (no cookie, expect 401) ---' -ForegroundColor Cyan
try {
  Invoke-RestMethod -Uri "$base/api/instructor/me"
} catch {
  Write-Host ('  status: ' + $_.Exception.Response.StatusCode.value__)
}

Write-Host ''
Write-Host '--- /api/sessions (no cookie, expect 401) ---' -ForegroundColor Cyan
try {
  Invoke-RestMethod -Uri "$base/api/sessions"
} catch {
  Write-Host ('  status: ' + $_.Exception.Response.StatusCode.value__)
}

Write-Host ''
Write-Host '--- GET / (no cookie, expect 302 redirect to /login.html) ---' -ForegroundColor Cyan
try {
  $r5 = Invoke-WebRequest -Uri "$base/" -MaximumRedirection 0 -ErrorAction Stop
  Write-Host ('  status: ' + $r5.StatusCode + ' (FAIL - should have redirected)') -ForegroundColor Red
} catch {
  $resp = $_.Exception.Response
  Write-Host ('  status:   ' + [int]$resp.StatusCode)
  Write-Host ('  location: ' + $resp.Headers.Location)
}

Write-Host ''
Write-Host '--- GET / (with cookie, expect 200 OK) ---' -ForegroundColor Cyan
$r6 = Invoke-WebRequest -Uri "$base/" -WebSession $session
$maxLen2 = [Math]::Min(80, $r6.Content.Length)
$preview = $r6.Content.Substring(0, $maxLen2).Replace("`n", ' ').Replace("`r", '')
Write-Host ('  status: ' + $r6.StatusCode)
Write-Host ('  body:   ' + $preview + '...')

Write-Host ''
Write-Host '--- /api/instructor/logout (clears cookie) ---' -ForegroundColor Cyan
$r7 = Invoke-WebRequest -Method POST -Uri "$base/api/instructor/logout" -WebSession $session
Write-Host ('  status: ' + $r7.StatusCode)

Write-Host ''
Write-Host '--- /api/instructor/me after logout (expect 401) ---' -ForegroundColor Cyan
try {
  Invoke-RestMethod -Uri "$base/api/instructor/me" -WebSession $session
  Write-Host '  unexpected success (FAIL)' -ForegroundColor Red
} catch {
  Write-Host ('  status: ' + $_.Exception.Response.StatusCode.value__)
}

Write-Host ''
Write-Host 'Smoke test complete.' -ForegroundColor Green
