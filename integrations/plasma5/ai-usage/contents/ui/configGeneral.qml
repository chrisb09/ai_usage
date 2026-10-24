import QtQuick 2.15
import QtQuick.Layouts 1.15
import org.kde.plasma.core 2.0 as PlasmaCore
import org.kde.plasma.components 3.0 as PlasmaComponents3

Item {
    id: page

    property alias cfg_baseUrl: baseUrlField.text
    property alias cfg_credentialCommand: credentialField.text
    property alias cfg_refreshIntervalSec: intervalSpin.value
    property alias cfg_compactQuotas: quotasField.text
    property alias cfg_barWidth: barWidthSpin.value

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: PlasmaCore.Units.smallSpacing
        spacing: PlasmaCore.Units.smallSpacing

        PlasmaComponents3.Label {
            text: i18n("Dashboard URL")
            font.bold: true
        }

        PlasmaComponents3.TextField {
            id: baseUrlField
            Layout.fillWidth: true
            placeholderText: "https://usage.example.com"
        }

        PlasmaComponents3.Label {
            Layout.fillWidth: true
            text: i18n("The widget reads GET /api/usage. Leave off the trailing slash.")
            font: PlasmaCore.Theme.smallestFont
            opacity: 0.65
            wrapMode: Text.WordWrap
        }

        PlasmaComponents3.Label {
            Layout.topMargin: PlasmaCore.Units.smallSpacing
            text: i18n("Credential command")
            font.bold: true
        }

        PlasmaComponents3.TextField {
            id: credentialField
            Layout.fillWidth: true
            placeholderText: "secret-tool lookup service ai-usage entry basic"
        }

        PlasmaComponents3.Label {
            Layout.fillWidth: true
            text: i18n("The command must print one line: base64(username:password), or a complete Basic header. The default reads the Secret Service/KWallet. Run scripts/setup-kwallet.sh once to create the entry.")
            font: PlasmaCore.Theme.smallestFont
            opacity: 0.65
            wrapMode: Text.WordWrap
        }

        PlasmaComponents3.Label {
            Layout.topMargin: PlasmaCore.Units.smallSpacing
            text: i18n("Panel quotas")
            font.bold: true
        }

        PlasmaComponents3.TextField {
            id: quotasField
            Layout.fillWidth: true
            placeholderText: "google:claude-weekly,codex:codex-weekly"
        }

        PlasmaComponents3.Label {
            Layout.fillWidth: true
            text: i18n("Comma-separated provider:quotaKey pairs. For Google accounts, the widget shows the account with the least remaining quota in that pool. The full popup always shows every account.")
            font: PlasmaCore.Theme.smallestFont
            opacity: 0.65
            wrapMode: Text.WordWrap
        }

        RowLayout {
            Layout.fillWidth: true
            Layout.topMargin: PlasmaCore.Units.smallSpacing
            spacing: PlasmaCore.Units.smallSpacing

            PlasmaComponents3.Label {
                Layout.fillWidth: true
                text: i18n("Refresh interval")
            }

            PlasmaComponents3.SpinBox {
                id: intervalSpin
                from: 15
                to: 3600
                stepSize: 15
                editable: true
                textFromValue: function (value, locale) { return value + " s" }
                valueFromText: function (text, locale) {
                    var parsed = parseInt(text, 10)
                    return isNaN(parsed) ? value : parsed
                }
            }
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: PlasmaCore.Units.smallSpacing

            PlasmaComponents3.Label {
                Layout.fillWidth: true
                text: i18n("Panel bar width")
            }

            PlasmaComponents3.SpinBox {
                id: barWidthSpin
                from: 40
                to: 120
                stepSize: 4
                editable: true
                textFromValue: function (value, locale) { return value + " px" }
                valueFromText: function (text, locale) {
                    var parsed = parseInt(text, 10)
                    return isNaN(parsed) ? value : parsed
                }
            }
        }

        Item {
            Layout.fillHeight: true
        }
    }
}
