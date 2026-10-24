import QtQuick 2.15
import QtQuick.Layouts 1.15
import org.kde.plasma.core 2.0 as PlasmaCore
import org.kde.plasma.components 3.0 as PlasmaComponents3

import "../code/usage.js" as Usage

ColumnLayout {
    id: row

    property var group: null

    readonly property color trackColor: Qt.rgba(
        PlasmaCore.Theme.textColor.r,
        PlasmaCore.Theme.textColor.g,
        PlasmaCore.Theme.textColor.b,
        0.16)

    Layout.fillWidth: true
    spacing: PlasmaCore.Units.smallSpacing

    RowLayout {
        Layout.fillWidth: true
        spacing: PlasmaCore.Units.smallSpacing

        PlasmaComponents3.Label {
            Layout.fillWidth: true
            text: row.group ? row.group.title : ""
            textFormat: Text.PlainText
            font.bold: true
            elide: Text.ElideRight
            maximumLineCount: 1
        }

        PlasmaComponents3.Label {
            visible: row.group && row.group.accountCount > 1
            text: row.group ? i18np("%1 account", "%1 accounts", row.group.accountCount) : ""
            textFormat: Text.PlainText
            font: PlasmaCore.Theme.smallestFont
            opacity: 0.6
        }
    }

    RowLayout {
        Layout.fillWidth: true
        spacing: PlasmaCore.Units.mediumSpacing

        Repeater {
            model: row.group ? row.group.windows : []

            delegate: ColumnLayout {
                Layout.fillWidth: true
                Layout.preferredWidth: 1
                spacing: 2

                RowLayout {
                    Layout.fillWidth: true
                    spacing: PlasmaCore.Units.smallSpacing

                    PlasmaComponents3.Label {
                        Layout.fillWidth: true
                        text: modelData.label
                        textFormat: Text.PlainText
                        font: PlasmaCore.Theme.smallestFont
                        opacity: 0.75
                    }

                    PlasmaComponents3.Label {
                        text: Usage.formatPct(modelData.remaining, true)
                        textFormat: Text.PlainText
                        color: Usage.remainingColor(modelData.remaining)
                        font.pixelSize: PlasmaCore.Theme.smallestFont.pixelSize
                        font.bold: true
                    }
                }

                QuotaBar {
                    Layout.fillWidth: true
                    Layout.preferredHeight: 6
                    remaining: modelData.remaining
                    marker: modelData.marker
                    statusColor: Usage.remainingColor(modelData.remaining)
                    trackColor: row.trackColor
                }

                PlasmaComponents3.Label {
                    Layout.fillWidth: true
                    text: modelData.balanceText.length > 0
                        ? modelData.balanceText
                        : modelData.resetText + (modelData.paceText.length > 0
                            ? " · " + modelData.paceText : "")
                    textFormat: Text.PlainText
                    font: PlasmaCore.Theme.smallestFont
                    opacity: 0.65
                    elide: Text.ElideRight
                    maximumLineCount: 1
                }
            }
        }
    }
}
