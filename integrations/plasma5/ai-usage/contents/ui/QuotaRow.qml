import QtQuick 2.15
import QtQuick.Layouts 1.15
import org.kde.plasma.core 2.0 as PlasmaCore
import org.kde.plasma.components 3.0 as PlasmaComponents3

import "../code/usage.js" as Usage

ColumnLayout {
    id: row

    property var quota: null
    property var account: null
    property string serverTime: ""

    readonly property real remaining: quota && typeof quota.remaining === "number"
        ? quota.remaining : -1
    readonly property real elapsed: quota ? Usage.elapsedFraction(quota, serverTime) : -1
    readonly property real marker: quota ? Usage.timeRemainingFraction(quota, serverTime) : -1
    readonly property string status: Usage.status(remaining, elapsed)
    readonly property color fillColor: Usage.statusColor(status)
    readonly property string balance: Usage.balanceText(quota)
    readonly property string pace: Usage.paceText(quota, serverTime)
    readonly property color trackColor: Qt.rgba(
        PlasmaCore.Theme.textColor.r,
        PlasmaCore.Theme.textColor.g,
        PlasmaCore.Theme.textColor.b,
        0.16)

    Layout.fillWidth: true
    spacing: Math.max(1, Math.round(PlasmaCore.Units.smallSpacing * 0.35))

    RowLayout {
        Layout.fillWidth: true
        spacing: PlasmaCore.Units.smallSpacing

        PlasmaComponents3.Label {
            Layout.fillWidth: true
            text: row.quota ? String(row.quota.label || row.quota.key || "") : ""
            textFormat: Text.PlainText
            elide: Text.ElideRight
            maximumLineCount: 1
        }

        PlasmaComponents3.Label {
            text: Usage.formatPct(row.remaining, true)
            textFormat: Text.PlainText
            color: row.fillColor
            font.bold: true
        }
    }

    QuotaBar {
        Layout.fillWidth: true
        Layout.preferredHeight: 6
        remaining: row.remaining
        marker: row.marker
        statusColor: row.fillColor
        trackColor: row.trackColor
    }

    RowLayout {
        Layout.fillWidth: true
        spacing: PlasmaCore.Units.smallSpacing

        PlasmaComponents3.Label {
            Layout.fillWidth: true
            text: Usage.formatReset(row.quota, row.serverTime)
            textFormat: Text.PlainText
            font: PlasmaCore.Theme.smallestFont
            opacity: 0.65
            elide: Text.ElideRight
            maximumLineCount: 1
        }

        PlasmaComponents3.Label {
            text: row.balance.length > 0 ? row.balance : row.pace
            textFormat: Text.PlainText
            font: PlasmaCore.Theme.smallestFont
            color: row.balance.length > 0 ? PlasmaCore.Theme.textColor : row.fillColor
            opacity: row.balance.length > 0 ? 0.75 : 0.9
        }
    }
}
