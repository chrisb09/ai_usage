import QtQuick 2.15

Item {
    id: bar

    property real remaining: -1
    property real marker: -1
    property color statusColor: "#8b949e"
    property color trackColor: Qt.rgba(0.5, 0.5, 0.5, 0.25)

    implicitHeight: 6
    implicitWidth: 64

    Rectangle {
        id: track
        anchors.fill: parent
        radius: height / 2
        color: bar.remaining >= 0 && bar.remaining <= 0.02
            ? Qt.rgba(bar.statusColor.r, bar.statusColor.g, bar.statusColor.b, 0.25)
            : bar.trackColor
    }

    Rectangle {
        id: fill
        anchors.left: parent.left
        anchors.top: parent.top
        anchors.bottom: parent.bottom
        width: bar.remaining > 0
            ? Math.max(2, Math.min(parent.width, parent.width * Math.min(bar.remaining, 1)))
            : 0
        radius: height / 2
        color: bar.statusColor
        visible: width > 0
    }

    Rectangle {
        anchors.top: parent.top
        anchors.bottom: parent.bottom
        x: Math.max(0, Math.min(parent.width - width, parent.width * bar.marker))
        width: 1
        color: Qt.rgba(0, 0, 0, 0.35)
        visible: bar.marker >= 0 && bar.marker <= 1
    }
}
