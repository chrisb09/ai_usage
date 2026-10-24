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

    Canvas {
        id: marker
        anchors.fill: parent
        visible: bar.marker >= 0 && bar.marker <= 1

        onPaint: {
            var ctx = getContext("2d")
            ctx.clearRect(0, 0, width, height)
            if (!visible) return

            var x = Math.max(1, Math.min(width - 2, width * bar.marker))

            ctx.lineWidth = 2
            ctx.strokeStyle = "rgba(0, 0, 0, 0.35)"
            ctx.setLineDash([])
            ctx.beginPath()
            ctx.moveTo(x, 0)
            ctx.lineTo(x, height)
            ctx.stroke()

            ctx.lineWidth = 1
            ctx.strokeStyle = "#ff5f56"
            ctx.globalAlpha = 0.9
            ctx.setLineDash([2, 2])
            ctx.beginPath()
            ctx.moveTo(x, 0)
            ctx.lineTo(x, height)
            ctx.stroke()
            ctx.globalAlpha = 1
            ctx.setLineDash([])
        }

        Connections {
            target: bar
            function onMarkerChanged() { marker.requestPaint() }
            function onWidthChanged() { marker.requestPaint() }
            function onHeightChanged() { marker.requestPaint() }
        }

        Component.onCompleted: requestPaint()
    }
}
