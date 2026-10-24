import QtQuick 2.15
import org.kde.plasma.core 2.0 as PlasmaCore

QtObject {
    id: client

    property string baseUrl: ""
    property string credentialCommand: ""
    property int refreshIntervalSec: 60

    property var accounts: []
    property string serverTime: ""
    property string basicHeader: ""
    property bool started: false
    property bool fetching: false
    property bool refreshing: false
    property bool authFailed: false
    property string errorText: ""
    property string credentialError: ""
    property double lastSuccessMs: 0

    property int requestSerial: 0
    property var request: null
    property var refreshRequest: null
    property string activeCredentialSource: ""

    readonly property string normalizedBaseUrl: {
        var url = String(baseUrl || "").trim()
        while (url.length > 1 && url.charAt(url.length - 1) === "/") {
            url = url.slice(0, -1)
        }
        return url
    }

    function start() {
        if (started) return
        started = true
        reloadCredentials()
    }

    function reloadCredentials() {
        requestSerial += 1
        fetching = false
        refreshing = false
        authFailed = false
        errorText = ""
        credentialError = ""
        request = null
        refreshRequest = null

        if (activeCredentialSource.length > 0) {
            try {
                executable.disconnectSource(activeCredentialSource)
            } catch (error) {
                // The source may already be gone.
            }
            activeCredentialSource = ""
        }

        var command = String(credentialCommand || "").trim()
        if (command.length === 0) {
            basicHeader = ""
            fetchUsage()
            return
        }

        activeCredentialSource = command
        try {
            executable.connectSource(command)
        } catch (error) {
            activeCredentialSource = ""
            credentialError = "Could not run the credential command: " + error
        }
    }

    function handleCredentialResult(sourceName, data) {
        if (sourceName !== activeCredentialSource) {
            try {
                executable.disconnectSource(sourceName)
            } catch (error) {
                // Ignore stale sources.
            }
            return
        }

        try {
            executable.disconnectSource(sourceName)
        } catch (error) {
            // Ignore.
        }
        activeCredentialSource = ""

        var exitCode = Number(data["exit code"])
        if (!isFinite(exitCode)) exitCode = 0
        if (exitCode !== 0) {
            credentialError = "Credential command failed (exit " + exitCode + "). Check the credential entry and the command in the widget settings."
            return
        }

        var stdout = String(data["stdout"] || "")
        var lines = stdout.split("\n")
        var value = ""
        for (var i = lines.length - 1; i >= 0; i--) {
            var line = lines[i].trim()
            if (line.length > 0) {
                value = line
                break
            }
        }

        if (value.length === 0) {
            credentialError = "No credential returned. Run scripts/setup-kwallet.sh or update the credential command."
            return
        }

        if (value.toLowerCase().indexOf("basic ") === 0) {
            basicHeader = value
        } else {
            basicHeader = "Basic " + value
        }
        fetchUsage()
    }

    function fetchUsage() {
        if (!started || credentialError.length > 0) return
        if (fetching || refreshing) return

        var url = normalizedBaseUrl
        if (url.length === 0) {
            errorText = "Set the dashboard URL in the widget settings."
            return
        }

        fetching = true
        var serial = ++requestSerial
        var finished = false
        var xhr = new XMLHttpRequest()
        request = xhr

        function finish() {
            if (finished) return false
            finished = true
            return true
        }

        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return
            if (!finish()) return
            if (serial !== requestSerial) return
            fetching = false
            request = null

            if (xhr.status >= 200 && xhr.status < 300) {
                try {
                    var parsed = JSON.parse(xhr.responseText)
                    if (!parsed || !Array.isArray(parsed.accounts)) {
                        throw new Error("unexpected payload")
                    }
                    accounts = parsed.accounts
                    serverTime = parsed.serverTime || new Date().toISOString()
                    lastSuccessMs = Date.now()
                    errorText = ""
                    authFailed = false
                } catch (error) {
                    errorText = "Invalid response from the dashboard: " + error
                }
            } else if (xhr.status === 401 || xhr.status === 403) {
                authFailed = true
                errorText = "Authentication failed (HTTP " + xhr.status + "). Check the credential entry."
            } else if (xhr.status === 0) {
                errorText = "Cannot reach " + url
            } else {
                errorText = "Request failed (HTTP " + xhr.status + ")"
            }
        }

        xhr.ontimeout = function () {
            if (!finish()) return
            if (serial !== requestSerial) return
            fetching = false
            request = null
            errorText = "Request timed out"
        }

        xhr.onerror = function () {
            if (!finish()) return
            if (serial !== requestSerial) return
            fetching = false
            request = null
            errorText = "Cannot reach " + url
        }

        try {
            xhr.open("GET", url + "/api/usage")
            xhr.setRequestHeader("Accept", "application/json")
            if (basicHeader.length > 0) {
                xhr.setRequestHeader("Authorization", basicHeader)
            }
            xhr.timeout = 15000
            xhr.send()
        } catch (error) {
            fetching = false
            request = null
            errorText = "Could not create the request: " + error
        }
    }

    function refreshProviders() {
        if (refreshing) return
        if (authFailed || credentialError.length > 0 || basicHeader.length === 0) {
            reloadCredentials()
            return
        }

        var url = normalizedBaseUrl
        if (url.length === 0) {
            errorText = "Set the dashboard URL in the widget settings."
            return
        }

        requestSerial += 1
        fetching = false
        refreshing = true
        var serial = requestSerial
        var finished = false
        var xhr = new XMLHttpRequest()
        refreshRequest = xhr

        function finish() {
            if (finished) return false
            finished = true
            return true
        }

        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return
            if (!finish()) return
            if (serial !== requestSerial) return
            refreshing = false
            refreshRequest = null

            if (xhr.status >= 200 && xhr.status < 300) {
                fetchUsage()
            } else if (xhr.status === 401 || xhr.status === 403) {
                authFailed = true
                errorText = "Authentication failed (HTTP " + xhr.status + "). Check the credential entry."
            } else if (xhr.status === 429) {
                errorText = "Refresh rate limit reached; try again in a minute."
            } else if (xhr.status === 0) {
                errorText = "Cannot reach " + url
            } else {
                errorText = "Refresh failed (HTTP " + xhr.status + ")"
            }
        }

        xhr.ontimeout = function () {
            if (!finish()) return
            if (serial !== requestSerial) return
            refreshing = false
            refreshRequest = null
            errorText = "Provider refresh timed out"
        }

        xhr.onerror = function () {
            if (!finish()) return
            if (serial !== requestSerial) return
            refreshing = false
            refreshRequest = null
            errorText = "Cannot reach " + url
        }

        try {
            xhr.open("POST", url + "/api/refresh")
            xhr.setRequestHeader("Accept", "application/json")
            xhr.setRequestHeader("Content-Type", "application/json")
            xhr.setRequestHeader("Authorization", basicHeader)
            xhr.timeout = 60000
            xhr.send("{}")
        } catch (error) {
            refreshing = false
            refreshRequest = null
            errorText = "Could not create the refresh request: " + error
        }
    }

    onBaseUrlChanged: {
        if (started) reloadCredentials()
    }

    onCredentialCommandChanged: {
        if (started) reloadCredentials()
    }

    property QtObject credentialSource: PlasmaCore.DataSource {
        id: executable
        engine: "executable"
        connectedSources: []

        onNewData: function (sourceName, data) {
            client.handleCredentialResult(sourceName, data)
        }
    }

    property QtObject pollTimer: Timer {
        interval: Math.max(15, client.refreshIntervalSec) * 1000
        running: client.started && !client.authFailed &&
                 client.credentialError.length === 0 && !client.refreshing
        repeat: true
        onTriggered: client.fetchUsage()
    }
}
