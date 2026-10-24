import QtQuick 2.15
import QtQuick.Layouts 1.15
import org.kde.plasma.core 2.0 as PlasmaCore
import org.kde.plasma.plasmoid 2.0

import "../code/usage.js" as Usage

Item {
    id: compact

    property var applet: null

    readonly property int barWidth: applet ? applet.barWidth : 72
    readonly property bool hasProblem: applet ? applet.hasProblem : false
    readonly property color trackColor: Qt.rgba(
        PlasmaCore.Theme.textColor.r,
        PlasmaCore.Theme.textColor.g,
        PlasmaCore.Theme.textColor.b,
        0.18)

    implicitWidth: barWidth + (hasProblem ? 8 : 0)
    implicitHeight: Math.max(5, bars.implicitHeight)
    Layout.preferredWidth: implicitWidth
    Layout.preferredHeight: implicitHeight

    Column {
        id: bars
        anchors.left: parent.left
        anchors.verticalCenter: parent.verticalCenter
        width: compact.barWidth
        spacing: 1

        Repeater {
            model: compact.applet ? compact.applet.compactSeries : []

            delegate: QuotaBar {
                width: compact.barWidth
                height: 5
                remaining: modelData && modelData.available ? modelData.remaining : -1
                marker: modelData && modelData.available ? modelData.marker : -1
                statusColor: modelData ? Usage.remainingColor(modelData.remaining) : Usage.COLOR_UNKNOWN
                trackColor: compact.trackColor
            }
        }

        Rectangle {
            visible: !compact.applet || compact.applet.compactSeries.length === 0
            width: compact.barWidth
            height: 5
            radius: 2.5
            color: compact.trackColor
        }
    }

    Rectangle {
        visible: compact.hasProblem
        anchors.left: bars.right
        anchors.leftMargin: 3
        anchors.verticalCenter: bars.verticalCenter
        width: 5
        height: 5
        radius: 2.5
        color: Usage.COLOR_CRITICAL
    }

    MouseArea {
        anchors.fill: parent
        acceptedButtons: Qt.LeftButton
        onClicked: Plasmoid.expanded = !Plasmoid.expanded
    }
}
