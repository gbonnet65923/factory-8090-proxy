$harDirectory = $PSScriptRoot
$credentialHar = $null
$templateHar = $null
$modelsHar = $null
$authHar = $null
$credentialHeaders = $null
foreach ($candidate in (Get-ChildItem -LiteralPath $harDirectory -Filter '*.har' -File |
        Sort-Object LastWriteTime -Descending)) {
    try {
        $har = Get-Content -LiteralPath $candidate.FullName -Raw | ConvertFrom-Json
        if (-not $authHar) {
            $authEntry = $har.log.entries | Where-Object {
                $_.request.url -like 'https://cognito-idp.*.amazonaws.com/*' -and
                $_.response.content.text -match '"RefreshToken"'
            } | Select-Object -Last 1
            if ($authEntry) { $authHar = $candidate.FullName }
        }
        if (-not $credentialHar) {
            $credentialRequest = $har.log.entries | Where-Object {
                $_.request.url -like 'https://api.factory.8090.dev/*' -and
                (@($_.request.headers | Where-Object { $_.name -ieq 'authorization' })).Count -gt 0 -and
                (@($_.request.headers | Where-Object { $_.name -ieq 'x-sofa-cognito-id-token' })).Count -gt 0 -and
                (@($_.request.headers | Where-Object { $_.name -ieq 'x-zed-token' })).Count -gt 0
            } | Select-Object -Last 1
            if ($credentialRequest) {
                $credentialHar = $candidate.FullName
                $credentialHeaders = $credentialRequest.request.headers
            }
        }
        $inputRequest = $har.log.entries | Where-Object { $_.request.method -eq 'POST' -and
            $_.request.url -match '/agents/chat-agent/input$' } | Select-Object -Last 1
        if ($inputRequest -and -not $templateHar) { $templateHar = $candidate.FullName }
        $modelsRequest = $har.log.entries | Where-Object { $_.request.method -eq 'GET' -and
            $_.request.url -match '/agents/models$' -and $_.response.status -eq 200 -and
            $_.response.content.text } | Select-Object -Last 1
        if ($modelsRequest -and -not $modelsHar) { $modelsHar = $candidate.FullName }
        if ($credentialHar -and $templateHar -and $modelsHar -and $authHar) { break }
    }
    catch { continue }
}
if (-not $credentialHar) { throw "No Factory HAR with authentication headers was found beside Start-Proxy.bat: $harDirectory" }
if (-not $templateHar) { $templateHar = $modelsHar }
if (-not $templateHar) { throw "No Factory HAR with a chat input or models request was found beside Start-Proxy.bat: $harDirectory" }
$getHeader = { param($name) ($credentialHeaders | Where-Object { $_.name -ieq $name } | Select-Object -First 1).value }
$env:FACTORY_HAR_PATH = $templateHar
if ($authHar) {
    $env:FACTORY_AUTH_HAR_PATH = $authHar
    $env:FACTORY_SESSION_PATH = Join-Path $PSScriptRoot 'factory-session.json'
}
$env:PROXY_CONVERSATIONS_PATH = Join-Path $PSScriptRoot 'factory-conversations.json'
if ($modelsHar) { $env:FACTORY_MODELS_HAR_PATH = $modelsHar }
$env:FACTORY_BEARER_TOKEN = (& $getHeader 'authorization') -replace '^Bearer\s+', ''
$env:FACTORY_COGNITO_TOKEN = & $getHeader 'x-sofa-cognito-id-token'
$env:FACTORY_ZED_TOKEN = & $getHeader 'x-zed-token'
$env:FACTORY_ORG_ID = & $getHeader 'x-sofa-active-org-id'
$env:FACTORY_WEB_CLIENT_VERSION = & $getHeader 'x-web-client-version'
$env:PROXY_API_KEY = 'local-trial'
try {
    Write-Host "Using credentials from $([IO.Path]::GetFileName($credentialHar)) and chat template from $([IO.Path]::GetFileName($templateHar))"
    if ($modelsHar) { Write-Host "Using model catalog from $([IO.Path]::GetFileName($modelsHar))" }
    if ($authHar) { Write-Host "Automatic token refresh enabled from $([IO.Path]::GetFileName($authHar))" }
    Push-Location -LiteralPath $PSScriptRoot
    try { & node .\server.mjs } finally { Pop-Location }
}
finally {
    Remove-Item Env:\FACTORY_HAR_PATH -ErrorAction SilentlyContinue
    Remove-Item Env:\FACTORY_MODELS_HAR_PATH -ErrorAction SilentlyContinue
    Remove-Item Env:\FACTORY_AUTH_HAR_PATH -ErrorAction SilentlyContinue
    Remove-Item Env:\FACTORY_SESSION_PATH -ErrorAction SilentlyContinue
    Remove-Item Env:\PROXY_CONVERSATIONS_PATH -ErrorAction SilentlyContinue
    Remove-Item Env:\FACTORY_BEARER_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:\FACTORY_COGNITO_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:\FACTORY_ZED_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:\FACTORY_ORG_ID -ErrorAction SilentlyContinue
    Remove-Item Env:\FACTORY_WEB_CLIENT_VERSION -ErrorAction SilentlyContinue
    Remove-Item Env:\PROXY_API_KEY -ErrorAction SilentlyContinue
}
