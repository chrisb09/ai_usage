import QtQuick 2.15
import org.kde.plasma.core 2.0 as PlasmaCore
import org.kde.plasma.plasmoid 2.0

import "../code/usage.js" as Usage

Item {
    id: root

    readonly property int barWidth: {
        var configured = Number(Plasmoid.configuration.barWidth)
        if (!isFinite(configured)) configured = 72
        return Math.max(40, Math.min(120, configured))
    }
    readonly property var summary: Usage.buildSummary(
        usageClient.accounts,
        usageClient.serverTime)
    readonly property var compactSeries: Usage.compactSummary(summary)
    readonly property var rows: Usage.buildRows(summary)
    readonly property int activeAccounts: Usage.activeCount(usageClient.accounts)
    readonly property int errorCount: Usage.errorCount(usageClient.accounts)
    readonly property bool hasProblem: usageClient.authFailed ||
        usageClient.credentialError.length > 0 ||
        usageClient.errorText.length > 0 ||
        errorCount > 0
    readonly property string dashboardUrl: usageClient.normalizedBaseUrl
    readonly property string fetchText: Usage.fetchedText(usageClient.lastSuccessMs)
    readonly property string serverTime: usageClient.serverTime
    readonly property var client: usageClient

    readonly property string summaryText: {
        if (usageClient.accounts.length === 0) {
            return usageClient.fetching ? i18n("loading…") : i18n("no accounts")
        }
        var text = i18np("%1 account", "%1 accounts", activeAccounts)
        if (errorCount > 0) {
            text += " · " + i18np("%1 error", "%1 errors", errorCount)
        }
        return text
    }

    readonly property string statusMessage: {
        if (usageClient.credentialError.length > 0) return usageClient.credentialError
        if (usageClient.authFailed) return i18n("Authentication failed. Check the credential entry or the command in the widget settings.")
        if (usageClient.errorText.length > 0) return usageClient.errorText
        return ""
    }

    readonly property string tooltipText: {
        var parts = []
        if (statusMessage.length > 0) parts.push(statusMessage)
        var summary = Usage.compactTooltip(compactSeries)
        if (summary.length > 0) parts.push(summary)
        parts.push(fetchText)
        return parts.join("\n")
    }

    Plasmoid.preferredRepresentation: Plasmoid.formFactor === PlasmaCore.Types.Planar
        ? Plasmoid.fullRepresentation
        : Plasmoid.compactRepresentation
    Plasmoid.backgroundHints: PlasmaCore.Types.DefaultBackground | PlasmaCore.Types.ConfigurableBackground
    Plasmoid.icon: hasProblem ? "dialog-warning" : "office-chart-bar"
    Plasmoid.title: i18n("AI Usage")
    Plasmoid.toolTipMainText: i18n("AI Usage")
    Plasmoid.toolTipSubText: tooltipText

    Plasmoid.compactRepresentation: CompactRepresentation {
        applet: root
    }

    Plasmoid.fullRepresentation: FullRepresentation {
        applet: root
    }

    UsageClient {
        id: usageClient
        baseUrl: Plasmoid.configuration.baseUrl
        credentialCommand: Plasmoid.configuration.credentialCommand
        refreshIntervalSec: Plasmoid.configuration.refreshIntervalSec
    }

    function refreshProviders() {
        usageClient.refreshProviders()
    }

    function reloadCredentials() {
        usageClient.reloadCredentials()
    }

    function openDashboard() {
        if (dashboardUrl.length > 0) {
            Qt.openUrlExternally(dashboardUrl)
        }
    }

    function action_reloadCredentials() {
        reloadCredentials()
    }

    function action_refreshProviders() {
        refreshProviders()
    }

    function action_openDashboard() {
        openDashboard()
    }

    Component.onCompleted: {
        Plasmoid.setAction("reloadCredentials", i18n("Reload credentials"), "view-refresh")
        Plasmoid.setAction("refreshProviders", i18n("Refresh providers"), "view-refresh")
        Plasmoid.setAction("openDashboard", i18n("Open dashboard"), "internet-web-browser")
        usageClient.start()
    }
}
