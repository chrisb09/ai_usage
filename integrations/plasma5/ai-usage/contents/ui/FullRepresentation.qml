import QtQuick 2.15
import QtQuick.Layouts 1.15
import org.kde.plasma.core 2.0 as PlasmaCore
import org.kde.plasma.components 3.0 as PlasmaComponents3
import org.kde.plasma.extras 2.0 as PlasmaExtras

import "../code/usage.js" as Usage

PlasmaExtras.Representation {
    id: full

    property var applet: null

    readonly property int rowMargin: PlasmaCore.Units.smallSpacing
    readonly property color trackColor: Qt.rgba(
        PlasmaCore.Theme.textColor.r,
        PlasmaCore.Theme.textColor.g,
        PlasmaCore.Theme.textColor.b,
        0.16)

    Layout.minimumWidth: PlasmaCore.Units.gridUnit * 19
    Layout.minimumHeight: PlasmaCore.Units.gridUnit * 15
    Layout.preferredWidth: PlasmaCore.Units.gridUnit * 23
    Layout.preferredHeight: PlasmaCore.Units.gridUnit * 24
    Layout.maximumWidth: PlasmaCore.Units.gridUnit * 34
    Layout.maximumHeight: PlasmaCore.Units.gridUnit * 44

    implicitWidth: PlasmaCore.Units.gridUnit * 23
    implicitHeight: PlasmaCore.Units.gridUnit * 24

    collapseMarginsHint: true
    focus: true

    header: PlasmaExtras.PlasmoidHeading {
        RowLayout {
            anchors.fill: parent
            anchors.leftMargin: full.rowMargin
            anchors.rightMargin: full.rowMargin
            spacing: full.rowMargin

            PlasmaComponents3.Label {
                text: i18n("AI Usage")
                font.bold: true
            }

            PlasmaComponents3.Label {
                Layout.fillWidth: true
                text: full.applet ? full.applet.summaryText : ""
                textFormat: Text.PlainText
                font: PlasmaCore.Theme.smallestFont
                opacity: 0.65
                elide: Text.ElideRight
            }

            PlasmaComponents3.BusyIndicator {
                Layout.preferredWidth: PlasmaCore.Units.iconSizes.small
                Layout.preferredHeight: PlasmaCore.Units.iconSizes.small
                visible: full.applet && (full.applet.client.fetching || full.applet.client.refreshing)
                running: visible
            }

            PlasmaComponents3.ToolButton {
                icon.name: "view-refresh"
                Accessible.name: i18n("Refresh providers")
                enabled: full.applet && !full.applet.client.refreshing
                onClicked: full.applet.refreshProviders()
            }
        }
    }

    contentItem: ColumnLayout {
        spacing: 0

        Rectangle {
            Layout.fillWidth: true
            Layout.leftMargin: full.rowMargin
            Layout.rightMargin: full.rowMargin
            Layout.topMargin: full.rowMargin
            visible: full.applet && full.applet.statusMessage.length > 0
            implicitHeight: bannerLabel.implicitHeight + 2 * PlasmaCore.Units.smallSpacing
            color: Qt.rgba(0.98, 0.32, 0.28, 0.14)
            radius: 3

            PlasmaComponents3.Label {
                id: bannerLabel
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.margins: PlasmaCore.Units.smallSpacing
                text: full.applet ? full.applet.statusMessage : ""
                textFormat: Text.PlainText
                font: PlasmaCore.Theme.smallestFont
                color: PlasmaCore.Theme.textColor
                wrapMode: Text.WordWrap
            }
        }

        Item {
            Layout.fillWidth: true
            Layout.fillHeight: true

            PlasmaComponents3.ScrollView {
                id: scrollView
                anchors.fill: parent
                background: null
                focus: true
                PlasmaComponents3.ScrollBar.horizontal.policy: PlasmaComponents3.ScrollBar.AlwaysOff

                contentItem: ListView {
                    id: list
                    model: full.applet ? full.applet.rows : []
                    clip: true
                    currentIndex: -1
                    topMargin: full.rowMargin
                    bottomMargin: full.rowMargin
                    spacing: 1
                    onModelChanged: positionViewAtBeginning()

                    delegate: Loader {
                        id: rowLoader
                        width: list.width
                        height: item ? item.implicitHeight : 0

                        sourceComponent: {
                            if (!modelData) return null
                            if (modelData.kind === "section") return sectionComponent
                            if (modelData.kind === "account") return accountComponent
                            if (modelData.kind === "error") return errorComponent
                            if (modelData.kind === "warning") return warningComponent
                            return quotaComponent
                        }

                        onLoaded: {
                            item.rowData = Qt.binding(function () { return modelData })
                            item.width = Qt.binding(function () { return rowLoader.width - 2 * full.rowMargin - 16 })
                            item.x = full.rowMargin
                        }
                    }

                    footer: Item {
                        width: list.width
                        implicitHeight: footerColumn.implicitHeight + 2 * full.rowMargin

                        ColumnLayout {
                            id: footerColumn
                            x: full.rowMargin
                            y: full.rowMargin
                            width: parent.width - 2 * full.rowMargin - 16
                            spacing: PlasmaCore.Units.smallSpacing

                            RowLayout {
                                Layout.fillWidth: true
                                spacing: full.rowMargin

                                QuotaBar {
                                    Layout.preferredWidth: 36
                                    Layout.preferredHeight: 6
                                    remaining: 0.75
                                    marker: 0.4
                                    statusColor: Usage.COLOR_GOOD
                                    trackColor: full.trackColor
                                }

                                PlasmaComponents3.Label {
                                    Layout.fillWidth: true
                                    text: i18n("Fill = remaining · dashed line = time remaining")
                                    textFormat: Text.PlainText
                                    font: PlasmaCore.Theme.smallestFont
                                    opacity: 0.65
                                    wrapMode: Text.WordWrap
                                }
                            }

                            PlasmaComponents3.Label {
                                Layout.fillWidth: true
                                text: full.applet ? full.applet.fetchText : ""
                                textFormat: Text.PlainText
                                font: PlasmaCore.Theme.smallestFont
                                opacity: 0.5
                                horizontalAlignment: Text.AlignRight
                            }
                        }
                    }
                }
            }

            PlasmaComponents3.Label {
                anchors.centerIn: parent
                visible: list.count === 0 &&
                         (!full.applet || full.applet.statusMessage.length === 0)
                text: full.applet && full.applet.client.fetching
                    ? i18n("Loading usage…")
                    : i18n("No usage data yet")
                textFormat: Text.PlainText
                font: PlasmaCore.Theme.smallestFont
                opacity: 0.7
            }
        }
    }

    Component {
        id: sectionComponent

        Item {
            id: sectionRow
            property var rowData

            implicitHeight: sectionLabel.implicitHeight + 8

            PlasmaComponents3.Label {
                id: sectionLabel
                y: 8
                width: sectionRow.width
                text: sectionRow.rowData ? sectionRow.rowData.title : ""
                textFormat: Text.PlainText
                font.bold: true
                opacity: 0.9
            }
        }
    }

    Component {
        id: accountComponent

        Item {
            id: accountRow
            property var rowData

            readonly property bool showLabel: rowData ? rowData.showLabel : false
            implicitHeight: showLabel ? accountHeader.implicitHeight : 0

            RowLayout {
                id: accountHeader
                width: accountRow.width
                visible: accountRow.showLabel
                spacing: full.rowMargin

                PlasmaComponents3.Label {
                    Layout.fillWidth: true
                    text: accountRow.rowData ? accountRow.rowData.account.label : ""
                    textFormat: Text.PlainText
                    font.bold: true
                    elide: Text.ElideRight
                    maximumLineCount: 1
                }

                PlasmaComponents3.Label {
                    text: accountRow.rowData
                        ? Usage.accountStatus(accountRow.rowData.account)
                        : ""
                    visible: text.length > 0
                    textFormat: Text.PlainText
                    font: PlasmaCore.Theme.smallestFont
                    color: accountRow.rowData && accountRow.rowData.account.lastError
                        ? Usage.COLOR_CRITICAL
                        : Usage.COLOR_WARNING
                }
            }
        }
    }

    Component {
        id: errorComponent

        Item {
            id: errorRow
            property var rowData

            implicitHeight: errorLabel.implicitHeight

            PlasmaComponents3.Label {
                id: errorLabel
                width: errorRow.width
                text: errorRow.rowData ? errorRow.rowData.text : ""
                textFormat: Text.PlainText
                font: PlasmaCore.Theme.smallestFont
                color: Usage.COLOR_CRITICAL
                wrapMode: Text.WordWrap
                maximumLineCount: 2
                elide: Text.ElideRight
            }
        }
    }

    Component {
        id: warningComponent

        Item {
            id: warningRow
            property var rowData

            implicitHeight: warningLabel.implicitHeight

            PlasmaComponents3.Label {
                id: warningLabel
                width: warningRow.width
                text: warningRow.rowData ? warningRow.rowData.text : ""
                textFormat: Text.PlainText
                font: PlasmaCore.Theme.smallestFont
                color: Usage.COLOR_WARNING
                wrapMode: Text.WordWrap
                maximumLineCount: 2
                elide: Text.ElideRight
            }
        }
    }

    Component {
        id: quotaComponent

        QuotaRow {
            property var rowData

            quota: rowData ? rowData.quota : null
            account: rowData ? rowData.account : null
            serverTime: full.applet ? full.applet.serverTime : ""
        }
    }
}
