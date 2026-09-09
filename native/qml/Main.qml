import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import QtQuick.Dialogs

ApplicationWindow {
    id: window
    width: 960
    height: 700
    minimumWidth: 560
    minimumHeight: 500
    visible: true
    title: "RebornBroadcaster"
    font.family: "Arial"
    color: "transparent"
    flags: Qt.Window | Qt.FramelessWindowHint

    property int page: 0
    property int settingsPage: 0
    property var backend: core
    property var state: ({})
    property var settings: ({})
    property var updateStatus: ({ "state": "idle", "launchedVersion": "", "latestVersion": "" })
    property bool coreConnected: Boolean(backend && backend.connected)
    property bool coreBusy: Boolean(backend && backend.busy)
    property string coreMessage: backend ? backend.message : "Controller is closing…"
    property int outerMargin: width < 720 || height < 560 ? 16 : 38
    property int liveSeconds: 0
    property bool radioLive: radioStatus === "live"
    property bool radioRunning: ["connecting", "live", "recovering", "backing-off"].indexOf(radioStatus) !== -1
    property bool recordingLive: recordingStatus === "recording"
    property bool recordingRunning: ["starting", "recording"].indexOf(recordingStatus) !== -1
    property bool videoLive: videoStatus === "live"
    property bool videoRunning: ["connecting", "starting", "live"].indexOf(videoStatus) !== -1
    property bool videoRecordingLive: videoRecordingStatus === "recording"
    property bool videoRecordingRunning: ["starting", "recording"].indexOf(videoRecordingStatus) !== -1
    property bool radioEnabled: state.outputs && state.outputs.radio ? state.outputs.radio.enabled === true : false
    property bool videoEnabled: state.outputs && state.outputs.video ? state.outputs.video.enabled === true : false
    property string radioStatus: state.outputs && state.outputs.radio ? state.outputs.radio.status : "stopped"
    property string videoStatus: state.outputs && state.outputs.video ? state.outputs.video.status : "disabled"
    property string recordingStatus: state.recording ? state.recording.status : "stopped"
    property string videoRecordingStatus: state.videoRecording ? state.videoRecording.status : "stopped"
    property string listenerText: state.listenerStatus === "available" ? "Listeners: " + state.listeners
        : state.listenerStatus === "hidden" ? "Listeners: hidden by server"
        : state.listenerStatus === "unavailable" ? "Listeners: unavailable"
        : "Listeners: —"
    property color blue: "#1e88e5"
    property color blueHover: "#1565c0"
    property color settingsBackground: "#333333"
    property color settingsPanel: "#292929"

    function applyState() {
        if (!backend) return
        try { state = JSON.parse(backend.stateJson || "{}") } catch (_) { state = ({}) }
    }

    function applySettings() {
        try {
            if (!backend) return
            settings = JSON.parse(backend.settingsJson || "{}")
            mountField.text = settings.mountpoint || ""
            userField.text = settings.username || "source"
            sourcePasswordField.text = settings.sourcepassword || ""
            hostField.text = settings.icecastHost || ""
            portField.text = settings.icecastPort || "8000"
            tlsEnabled.checked = settings.icecastTls === true
            proxyPathField.text = settings.icecastProxyPath || ""
            legacySourceEnabled.checked = settings.icecastLegacySource === true
            streamNameField.text = settings.streamName || ""
            genreField.text = settings.streamGenre || ""
            descriptionField.text = settings.streamDescription || ""
            streamUrlField.text = settings.streamUrl || ""
            publicCombo.currentIndex = String(settings.streamPublic) === "1" ? 1 : 0
            nowPlayingField.text = settings.nowPlaying || ""
            nowPlayingFileEnabled.checked = settings.nowPlayingFileEnabled === true
            nowPlayingFileField.text = settings.nowPlayingFile || ""
            encodingCombo.currentIndex = Math.max(0, encodingCombo.model.indexOf(settings.encodingType || "mp3"))
            sourceField.text = settings.audioSourceName || ""
            bitrateField.value = Number(settings.bitrate || 128)
            recordingField.text = settings.recordingPath || ""
            adaptiveEnabled.checked = settings.adaptiveBackoffEnabled !== false
            icecastEnabled.checked = settings.icecastEnabled !== false
            obsEnabled.checked = settings.obsEnabled === true
            obsAutoLaunch.checked = settings.obsAutoLaunch === true
            obsHostField.text = settings.obsHost || "127.0.0.1"
            obsPortField.text = String(settings.obsPort || 4455)
            obsPasswordField.text = settings.obsPassword || ""
            obsPathField.text = settings.obsExePath || ""
        } catch (_) {}
    }

    function applyUpdateStatus() {
        try {
            if (backend) updateStatus = JSON.parse(backend.updateStatusJson || "{}")
        } catch (_) {
            updateStatus = ({ "state": "error", "error": "Update status unavailable" })
        }
    }

    function updateStatusText() {
        let stateName = updateStatus.state || "idle"
        let launched = updateStatus.launchedVersion || "unknown"
        let latest = updateStatus.latestVersion || "not checked"
        if (stateName === "checking") return "Launched version " + launched + "  •  Checking for the latest version…"
        if (stateName === "available") return "Launched version " + launched + "  •  Latest version " + latest + "  •  Update found"
        if (stateName === "downloading") return "Launched version " + launched + "  •  Latest version " + latest + "  •  Downloading update…"
        if (stateName === "ready") return "Launched version " + launched + "  •  Latest version " + latest + "  •  Update ready"
        if (stateName === "installing" || stateName === "awaitingHealth") return "Launched version " + launched + "  •  Latest version " + latest + "  •  Installing update…"
        if (stateName === "upToDate") return "Launched version " + launched + "  •  Latest version " + (updateStatus.latestVersion || launched) + "  •  Up to date"
        if (stateName === "error" || stateName === "unavailable") return "Launched version " + launched + "  •  " + (updateStatus.error || "Updater unavailable")
        return "Launched version " + launched + "  •  Latest version " + latest
    }

    function saveSettings() {
        if (!backend) return
        backend.saveSettings(JSON.stringify({
            mountpoint: mountField.text, username: userField.text,
            sourcepassword: sourcePasswordField.text, icecastHost: hostField.text,
            icecastPort: portField.text, icecastTls: tlsEnabled.checked,
            icecastProxyPath: proxyPathField.text, icecastLegacySource: legacySourceEnabled.checked,
            streamName: streamNameField.text,
            streamGenre: genreField.text, streamDescription: descriptionField.text,
            streamUrl: streamUrlField.text, streamPublic: publicCombo.currentIndex === 1 ? "1" : "0",
            nowPlaying: nowPlayingField.text,
            nowPlayingFileEnabled: nowPlayingFileEnabled.checked,
            nowPlayingFile: nowPlayingFileField.text,
            encodingType: encodingCombo.currentText,
            audioSourceName: sourceField.text, bitrate: bitrateField.value,
            recordingPath: recordingField.text, adaptiveBackoffEnabled: adaptiveEnabled.checked,
            icecastEnabled: icecastEnabled.checked, obsEnabled: obsEnabled.checked,
            obsAutoLaunch: obsAutoLaunch.checked, obsHost: obsHostField.text,
            obsPort: Number(obsPortField.text), obsPassword: obsPasswordField.text,
            obsExePath: obsPathField.text
        }))
    }

    function elapsedText() {
        if (!radioLive) return "Standby"
        let hours = Math.floor(liveSeconds / 3600)
        let minutes = Math.floor((liveSeconds % 3600) / 60)
        let seconds = liveSeconds % 60
        return "Live " + String(hours).padStart(2, "0") + ":" + String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0")
    }

    function addLog(message) {
        if (!message) return
        logModel.append({ messageText: new Date().toLocaleTimeString() + "  " + message })
        if (logModel.count > 250) logModel.remove(0)
        logView.positionViewAtEnd()
    }

    Component.onCompleted: {
        applyState()
        if (backend) backend.loadSettings()
        addLog("RebornBroadcaster native controller started")
        applyUpdateStatus()
    }

    onRadioLiveChanged: { if (!radioLive) liveSeconds = 0 }

    Connections {
        target: window.backend
        ignoreUnknownSignals: true
        function onStateJsonChanged() { window.applyState() }
        function onSettingsJsonChanged() { window.applySettings() }
        function onMessageChanged() { window.addLog(window.coreMessage) }
        function onUpdateStatusChanged() { window.applyUpdateStatus() }
    }

    Timer { interval: 1000; repeat: true; running: window.radioLive; onTriggered: window.liveSeconds++ }
    Timer { interval: 2500; repeat: true; running: Boolean(window.backend); onTriggered: { if (window.backend) window.backend.refresh() } }
    ListModel { id: logModel }

    FileDialog {
        id: nowPlayingFileDialog
        title: "Select now-playing text file"
        nameFilters: ["Text files (*.txt)", "All files (*)"]
        fileMode: FileDialog.OpenFile
        onAccepted: {
            if (window.backend) nowPlayingFileField.text = window.backend.localFilePath(selectedFile.toString())
        }
    }

    FileDialog {
        id: importDialog
        title: "Import RebornBroadcaster configuration"
        nameFilters: ["JSON configuration (*.json)"]
        fileMode: FileDialog.OpenFile
        onAccepted: { if (window.backend) window.backend.importConfig(selectedFile.toString()) }
    }

    MessageDialog {
        id: stopCoreDialog
        title: "Stop RebornBroadcaster core"
        text: "This will stop every stream and recording before closing the core. Continue?"
        buttons: MessageDialog.Yes | MessageDialog.No
        onButtonClicked: function(button, role) {
            if (button === MessageDialog.Yes && window.backend) window.backend.stopCore()
        }
    }

    FileDialog {
        id: exportDialog
        title: "Export RebornBroadcaster configuration"
        nameFilters: ["JSON configuration (*.json)"]
        fileMode: FileDialog.SaveFile
        defaultSuffix: "json"
        onAccepted: { if (window.backend) window.backend.exportConfig(selectedFile.toString(), includeSecrets.checked) }
    }

    component BlueButton: Button {
        id: control
        property bool danger: false
        implicitHeight: 42
        font.pixelSize: 15
        font.bold: true
        contentItem: Text {
            text: control.text; color: "white"; font: control.font
            horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter
            elide: Text.ElideRight
        }
        background: Rectangle {
            radius: 5
            color: !control.enabled ? "#8b98a5" : control.down ? (control.danger ? "#8d1f2b" : "#0d5595") : control.hovered ? (control.danger ? "#b72f3e" : window.blueHover) : (control.danger ? "#d64555" : window.blue)
        }
    }

    component SettingsTab: Button {
        id: tab
        property int tabIndex: 0
        Layout.fillWidth: true
        implicitHeight: 42
        flat: true
        contentItem: Text {
            text: tab.text; color: "white"; font.pixelSize: 14
            font.bold: window.settingsPage === tab.tabIndex
            leftPadding: 12; verticalAlignment: Text.AlignVCenter
        }
        background: Rectangle {
            radius: 8
            color: window.settingsPage === tab.tabIndex ? "#275f91" : (tab.hovered ? "#454545" : "#242424")
            border.color: window.settingsPage === tab.tabIndex ? window.blue : "#555555"
        }
        onClicked: window.settingsPage = tabIndex
    }

    component FieldLabel: Label { color: "#dddddd"; font.pixelSize: 13 }

    component DarkField: TextField {
        Layout.fillWidth: true
        implicitHeight: 40
        color: "white"
        placeholderTextColor: "#999999"
        selectionColor: window.blue
        background: Rectangle {
            radius: 5; color: "#444444"
            border.color: parent.activeFocus ? window.blue : "#595959"
        }
    }

    component SettingGroup: ColumnLayout { Layout.fillWidth: true; spacing: 5 }

    Canvas {
        id: backgroundCanvas
        anchors.fill: parent
        onWidthChanged: requestPaint()
        onHeightChanged: requestPaint()
        onPaint: {
            const context = getContext("2d")
            context.clearRect(0, 0, width, height)
            const gradient = context.createLinearGradient(0, 0, width, height)
            gradient.addColorStop(0, "#d90000")
            gradient.addColorStop(0.3, "#080808")
            gradient.addColorStop(0.6, "#ff5a5a")
            gradient.addColorStop(0.9, "#b80000")
            gradient.addColorStop(1, "#090909")
            context.fillStyle = gradient
            context.fillRect(0, 0, width, height)
        }
    }

    Rectangle {
        id: dragBar
        anchors.top: parent.top; anchors.left: parent.left; anchors.right: parent.right
        height: 34; color: "transparent"; z: 20
        MouseArea { anchors.fill: parent; onPressed: window.startSystemMove() }
        Text {
            anchors.left: parent.left; anchors.leftMargin: 16; anchors.verticalCenter: parent.verticalCenter
            anchors.right: windowControls.left; anchors.rightMargin: 8
            text: "REBORN BROADCASTER"; color: "white"; font.pixelSize: 11; font.bold: true; font.letterSpacing: 2
            elide: Text.ElideRight
        }
        Row {
            id: windowControls
            anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter; anchors.rightMargin: 7; spacing: 2
            Button {
                width: 42; height: 28; text: "—"; flat: true
                contentItem: Text { text: parent.text; color: "white"; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter }
                background: Rectangle { color: parent.hovered ? "#55000000" : "transparent" }
                onClicked: window.showMinimized()
            }
            Button {
                width: 42; height: 28; text: window.visibility === Window.Maximized ? "❐" : "□"; flat: true
                contentItem: Text { text: parent.text; color: "white"; font.pixelSize: 16; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter }
                background: Rectangle { color: parent.hovered ? "#55000000" : "transparent" }
                onClicked: window.visibility === Window.Maximized ? window.showNormal() : window.showMaximized()
            }
            Button {
                width: 42; height: 28; text: "×"; flat: true
                contentItem: Text { text: parent.text; color: "white"; font.pixelSize: 20; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter }
                background: Rectangle { color: parent.hovered ? "#d32f2f" : "transparent" }
                onClicked: window.close()
            }
        }
    }

    MouseArea {
        anchors.left: parent.left; anchors.top: parent.top; anchors.bottom: parent.bottom
        width: 6; z: 50; cursorShape: Qt.SizeHorCursor
        enabled: window.visibility !== Window.Maximized
        onPressed: window.startSystemResize(Qt.LeftEdge)
    }
    MouseArea {
        anchors.right: parent.right; anchors.top: parent.top; anchors.bottom: parent.bottom
        width: 6; z: 50; cursorShape: Qt.SizeHorCursor
        enabled: window.visibility !== Window.Maximized
        onPressed: window.startSystemResize(Qt.RightEdge)
    }
    MouseArea {
        anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top
        height: 6; z: 50; cursorShape: Qt.SizeVerCursor
        enabled: window.visibility !== Window.Maximized
        onPressed: window.startSystemResize(Qt.TopEdge)
    }
    MouseArea {
        anchors.left: parent.left; anchors.right: parent.right; anchors.bottom: parent.bottom
        height: 6; z: 50; cursorShape: Qt.SizeVerCursor
        enabled: window.visibility !== Window.Maximized
        onPressed: window.startSystemResize(Qt.BottomEdge)
    }

    StackLayout {
        anchors.fill: parent
        anchors.topMargin: 34
        anchors.margins: window.outerMargin
        currentIndex: window.page

        Rectangle {
            radius: 12; color: "white"; border.color: "#dddddd"
            ColumnLayout {
                anchors.fill: parent; anchors.margins: window.height < 560 ? 12 : 24
                spacing: window.height < 560 ? 10 : 18
                ColumnLayout {
                    Layout.fillWidth: true; spacing: 6
                    Text {
                        text: "Status: " + (window.radioLive || window.videoLive ? "Live" : window.coreConnected ? "Idle" : "Core Offline")
                        color: "#333333"; font.pixelSize: 19; font.bold: true
                        horizontalAlignment: Text.AlignHCenter; Layout.fillWidth: true
                    }
                    Text {
                        text: "Radio and video run independently. Starting all outputs never starts a recording."
                        color: "#666666"; font.pixelSize: 12; horizontalAlignment: Text.AlignHCenter; Layout.fillWidth: true
                        wrapMode: Text.WordWrap
                    }
                }

                GridLayout {
                    Layout.fillWidth: true
                    columns: window.width >= 760 ? 2 : 1
                    columnSpacing: 12; rowSpacing: 10

                    Rectangle {
                        Layout.fillWidth: true; implicitHeight: window.height < 560 ? 130 : 150; radius: 8
                        color: "#f5f8fb"; border.color: "#c7d3df"
                        ColumnLayout {
                            anchors.fill: parent; anchors.margins: 12; spacing: 7
                            RowLayout {
                                Layout.fillWidth: true
                                Text { text: "RADIO / ICECAST"; color: "#183f63"; font.pixelSize: 15; font.bold: true }
                                Item { Layout.fillWidth: true }
                                Text { text: window.radioStatus.toUpperCase(); color: window.radioLive ? "#218838" : "#666666"; font.bold: true }
                            }
                            Text {
                                text: window.listenerText + "  •  " + window.elapsedText()
                                color: "#555555"; font.pixelSize: 13
                            }
                            RowLayout {
                                Layout.fillWidth: true; spacing: 8
                                BlueButton {
                                    Layout.fillWidth: true; text: window.radioRunning ? "Stop Radio" : "Start Radio"
                                    enabled: window.coreConnected && window.radioEnabled && !window.coreBusy; danger: window.radioRunning
                                    onClicked: { if (window.backend) window.radioRunning ? window.backend.stopRadio() : window.backend.startRadio() }
                                }
                                BlueButton {
                                    Layout.fillWidth: true; text: window.recordingRunning ? "Stop Audio Recording" : "Record Audio"
                                    enabled: window.coreConnected && !window.coreBusy; danger: window.recordingRunning
                                    onClicked: { if (window.backend) window.recordingRunning ? window.backend.stopRecording() : window.backend.startRecording() }
                                }
                            }
                        }
                    }

                    Rectangle {
                        Layout.fillWidth: true; implicitHeight: window.height < 560 ? 130 : 150; radius: 8
                        color: "#f5f8fb"; border.color: "#c7d3df"
                        ColumnLayout {
                            anchors.fill: parent; anchors.margins: 12; spacing: 7
                            RowLayout {
                                Layout.fillWidth: true
                                Text { text: "VIDEO / OBS"; color: "#183f63"; font.pixelSize: 15; font.bold: true }
                                Item { Layout.fillWidth: true }
                                Text { text: window.videoStatus.toUpperCase(); color: window.videoLive ? "#218838" : "#666666"; font.bold: true }
                            }
                            Text { text: "Recording: " + window.videoRecordingStatus; color: "#555555"; font.pixelSize: 13 }
                            RowLayout {
                                Layout.fillWidth: true; spacing: 8
                                BlueButton {
                                    Layout.fillWidth: true; text: window.videoRunning ? "Stop Video" : "Start Video"
                                    enabled: window.coreConnected && window.videoEnabled && !window.coreBusy; danger: window.videoRunning
                                    onClicked: { if (window.backend) window.videoRunning ? window.backend.stopVideo() : window.backend.startVideo() }
                                }
                                BlueButton {
                                    Layout.fillWidth: true; text: window.videoRecordingRunning ? "Stop Video Recording" : "Record Video"
                                    enabled: window.coreConnected && window.videoEnabled && !window.coreBusy; danger: window.videoRecordingRunning
                                    onClicked: { if (window.backend) window.videoRecordingRunning ? window.backend.stopVideoRecording() : window.backend.startVideoRecording() }
                                }
                            }
                        }
                    }
                }

                Flow {
                    Layout.fillWidth: true; spacing: 10
                    BlueButton {
                        width: 190; text: window.radioRunning || window.videoRunning ? "Stop Streaming Outputs" : "Start All Enabled Outputs"
                        enabled: window.coreConnected && !window.coreBusy; danger: window.radioRunning || window.videoRunning
                        onClicked: { if (window.backend) danger ? window.backend.stopLive() : window.backend.goLive() }
                    }
                    BlueButton { width: 120; text: "Settings"; onClicked: { window.page = 1; if (window.backend) window.backend.loadSettings() } }
                    BlueButton { width: 100; text: "About"; onClicked: window.page = 2 }
                }

                Rectangle {
                    Layout.fillWidth: true; Layout.fillHeight: true; Layout.minimumHeight: window.height < 620 ? 100 : 150
                    visible: window.height >= 600
                    color: "#111111"; border.color: "#333333"; border.width: 1
                    ListView {
                        id: logView
                        anchors.fill: parent; anchors.margins: 10; clip: true; model: logModel; spacing: 3
                        delegate: Text {
                            required property string messageText
                            width: logView.width; text: messageText; color: "#00ee32"
                            font.family: "Consolas"; font.pixelSize: 13; wrapMode: Text.WrapAnywhere
                        }
                        ScrollBar.vertical: ScrollBar {}
                    }
                }

                RowLayout {
                    Layout.fillWidth: true
                    visible: window.height >= 540
                    Text { text: window.coreConnected ? "Core connected on localhost:8010" : "Waiting for broadcast core…"; color: window.coreConnected ? "#218838" : "#a73734"; font.pixelSize: 12 }
                    Item { Layout.fillWidth: true }
                    Text { text: window.coreMessage; color: "#666666"; font.pixelSize: 12; elide: Text.ElideRight; Layout.maximumWidth: 450 }
                    BlueButton {
                        text: window.coreConnected ? "Stop Core" : "Start Core"
                        danger: window.coreConnected
                        enabled: !window.coreBusy
                        onClicked: {
                            if (!window.backend) return
                            if (!window.coreConnected) window.backend.ensureCore()
                            else if (window.backend.activeOutputs) stopCoreDialog.open()
                            else window.backend.stopCore()
                        }
                    }
                }
            }
        }

        Rectangle {
            radius: 12; color: window.settingsBackground; border.color: "#555555"
            RowLayout {
                anchors.fill: parent; anchors.margins: 18; spacing: 16
                ColumnLayout {
                    Layout.minimumWidth: window.width < 760 ? 118 : 165
                    Layout.preferredWidth: window.width < 760 ? 118 : 165
                    Layout.maximumWidth: window.width < 760 ? 118 : 165
                    Layout.fillHeight: true; spacing: 8
                    Text { text: "Settings"; color: "white"; font.pixelSize: 24; font.bold: true; Layout.bottomMargin: 8 }
                    SettingsTab { text: "Status"; tabIndex: 0 }
                    SettingsTab { text: "Stream"; tabIndex: 1 }
                    SettingsTab { text: "Audio"; tabIndex: 2 }
                    SettingsTab { text: "Recording"; tabIndex: 3 }
                    SettingsTab { text: "ScrollBytes Live"; tabIndex: 4 }
                    SettingsTab { text: "Config"; tabIndex: 5 }
                    Item { Layout.fillHeight: true }
                    BlueButton { Layout.fillWidth: true; text: window.width < 760 ? "Console" : "Back to Console"; onClicked: window.page = 0 }
                }

                Rectangle {
                    Layout.fillWidth: true; Layout.fillHeight: true; radius: 10
                    color: window.settingsPanel; border.color: "#4b4b4b"
                    ColumnLayout {
                        anchors.fill: parent; anchors.margins: 16; spacing: 12
                        StackLayout {
                            currentIndex: window.settingsPage
                            Layout.fillWidth: true; Layout.fillHeight: true

                            ColumnLayout {
                                Text { text: "Application Updates"; color: "white"; font.pixelSize: 21; font.bold: true }
                                Rectangle {
                                    Layout.fillWidth: true
                                    implicitHeight: 82
                                    radius: 7
                                    color: "#181818"
                                    border.color: window.updateStatus.state === "ready" ? "#d7a72f"
                                                : window.updateStatus.state === "error" || window.updateStatus.state === "unavailable" ? "#a73734"
                                                : "#444444"
                                    RowLayout {
                                        anchors.fill: parent
                                        anchors.margins: 12
                                        spacing: 14
                                        BlueButton {
                                            text: window.updateStatus.state === "ready" ? "Install and Restart" : "Check Now"
                                            enabled: ["checking", "available", "downloading", "installing", "awaitingHealth"].indexOf(window.updateStatus.state) < 0
                                            onClicked: { if (window.backend) window.backend.updateAction() }
                                        }
                                        Text {
                                            Layout.fillWidth: true
                                            text: window.updateStatusText()
                                            color: window.updateStatus.state === "ready" ? "#ffd166"
                                                 : window.updateStatus.state === "error" || window.updateStatus.state === "unavailable" ? "#ff8a80"
                                                 : "#bdbdbd"
                                            wrapMode: Text.WordWrap
                                        }
                                    }
                                }
                                Rectangle { Layout.fillWidth: true; height: 1; color: "#444444" }
                                Text { text: "Broadcast Status"; color: "white"; font.pixelSize: 21; font.bold: true }
                                TextArea {
                                    Layout.fillWidth: true; Layout.fillHeight: true; readOnly: true
                                    color: "#00ee32"; font.family: "Consolas"; font.pixelSize: 12
                                    text: JSON.stringify(window.state, null, 2)
                                    background: Rectangle { color: "#111111"; border.color: "#444444" }
                                }
                                BlueButton { Layout.fillWidth: true; text: "Refresh Status"; onClicked: { if (window.backend) window.backend.refresh() } }
                            }

                            ScrollView {
                                contentWidth: availableWidth
                                ColumnLayout {
                                    width: parent.width - 14; spacing: 12
                                    Text { text: "Icecast Stream"; color: "white"; font.pixelSize: 21; font.bold: true }
                                    GridLayout {
                                        Layout.fillWidth: true; columns: 2; columnSpacing: 14; rowSpacing: 10
                                        SettingGroup { FieldLabel { text: "Mountpoint" } DarkField { id: mountField; placeholderText: "stream" } }
                                        SettingGroup { FieldLabel { text: "Source username" } DarkField { id: userField; placeholderText: "source" } }
                                        SettingGroup { FieldLabel { text: "Source password" } DarkField { id: sourcePasswordField; echoMode: TextInput.Password } }
                                        SettingGroup { FieldLabel { text: "Icecast host" } DarkField { id: hostField; placeholderText: "radio.example.com" } }
                                        SettingGroup { FieldLabel { text: "Public connection port" } DarkField { id: portField; placeholderText: "443" } }
                                        SettingGroup { FieldLabel { text: "Reverse-proxy path" } DarkField { id: proxyPathField; placeholderText: "radiostation" } }
                                        SettingGroup { FieldLabel { text: "Station name" } DarkField { id: streamNameField; placeholderText: "Station name" } }
                                        SettingGroup { FieldLabel { text: "Genre" } DarkField { id: genreField; placeholderText: "Variety" } }
                                        SettingGroup { FieldLabel { text: "Station/show website (not the listen URL)" } DarkField { id: streamUrlField; placeholderText: "https://example.com" } }
                                    }
                                    CheckBox { id: tlsEnabled; text: "Secure source, metadata, and status connections with TLS"; palette.windowText: "white" }
                                    CheckBox { id: legacySourceEnabled; text: "Use Icecast SOURCE compatibility for IIS/path proxies"; palette.windowText: "white" }
                                    Text { text: "Path-proxy configs imported from older versions enable SOURCE compatibility automatically. Disable it only when the Icecast provider requires modern PUT."; color: "#bbbbbb"; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                                    SettingGroup { FieldLabel { text: "Description" } DarkField { id: descriptionField; placeholderText: "Station description" } }
                                    SettingGroup { FieldLabel { text: "Icecast directory advertisement" } ComboBox { id: publicCombo; Layout.fillWidth: true; model: ["Do not request YP listing", "Request public YP listing"] } }
                                    Text { text: "The server can override directory advertisement. This does not hide the mount, status page, or listen URL."; color: "#bbbbbb"; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                                    SettingGroup {
                                        FieldLabel { text: "Now playing" }
                                        RowLayout {
                                            Layout.fillWidth: true
                                            DarkField { id: nowPlayingField; Layout.fillWidth: true; placeholderText: "Artist - Title" }
                                            BlueButton { text: "Send Now"; enabled: window.radioLive && !window.coreBusy; onClicked: { if (window.backend) window.backend.updateNowPlaying(nowPlayingField.text) } }
                                        }
                                    }
                                    CheckBox { id: nowPlayingFileEnabled; text: "Automatically sync now playing from a text file"; palette.windowText: "white" }
                                    SettingGroup {
                                        FieldLabel { text: "Now-playing text file (first non-empty line)" }
                                        RowLayout {
                                            Layout.fillWidth: true
                                            DarkField { id: nowPlayingFileField; Layout.fillWidth: true; enabled: nowPlayingFileEnabled.checked; placeholderText: "C:\\Radio\\now-playing.txt" }
                                            BlueButton { text: "Browse"; enabled: nowPlayingFileEnabled.checked; onClicked: nowPlayingFileDialog.open() }
                                        }
                                    }
                                    Text { text: "Station metadata changes apply on the next stream connection. Now-playing changes can be sent while live and file sync checks every two seconds."; color: "#bbbbbb"; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                                    Text {
                                        text: "Metadata status: " + (window.state.metadataStatus || "idle")
                                            + (window.state.metadataError ? " — " + window.state.metadataError : "")
                                        color: window.state.metadataStatus === "error" || window.state.metadataStatus === "file-error" ? "#ff8a80" : "#9fc5e8"
                                        wrapMode: Text.WordWrap; Layout.fillWidth: true
                                    }
                                }
                            }

                            ScrollView {
                                contentWidth: availableWidth
                                ColumnLayout {
                                    width: parent.width - 14; spacing: 14
                                    Text { text: "Audio Encoding"; color: "white"; font.pixelSize: 21; font.bold: true }
                                    SettingGroup { FieldLabel { text: "Encoding" } ComboBox { id: encodingCombo; Layout.fillWidth: true; model: ["mp3", "aac", "opus", "vorbis"] } }
                                    SettingGroup { FieldLabel { text: "Audio source name" } DarkField { id: sourceField; placeholderText: "VoiceMeeter Output (VB-Audio VoiceMeeter VAIO)" } }
                                    SettingGroup { FieldLabel { text: "Bitrate (kbps)" } SpinBox { id: bitrateField; Layout.fillWidth: true; from: 8; to: 2048; value: 128; editable: true } }
                                    CheckBox { id: adaptiveEnabled; text: "Safely back off after sustained encoder lag"; checked: true; palette.windowText: "white" }
                                    Text { text: "The media core backs off only after sustained lag. Recording and OBS remain isolated from Icecast recovery."; color: "#bbbbbb"; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                                }
                            }

                            ColumnLayout {
                                Text { text: "Recording"; color: "white"; font.pixelSize: 21; font.bold: true }
                                SettingGroup { FieldLabel { text: "Recording folder or .mkv file" } DarkField { id: recordingField; placeholderText: "Defaults to Music/RebornBroadcaster" } }
                                Text { text: "Recordings use lossless FLAC audio in a resilient Matroska container and stop gracefully before the process exits."; color: "#bbbbbb"; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                                BlueButton { Layout.fillWidth: true; text: window.recordingLive ? "Stop Recording" : "Start Recording"; danger: window.recordingLive; onClicked: { if (window.backend) window.recordingLive ? window.backend.stopRecording() : window.backend.startRecording() } }
                                Item { Layout.fillHeight: true }
                            }

                            ScrollView {
                                contentWidth: availableWidth
                                ColumnLayout {
                                    width: parent.width - 14; spacing: 12
                                    Text { text: "ScrollBytes Live / OBS"; color: "white"; font.pixelSize: 21; font.bold: true }
                                    Rectangle {
                                        Layout.fillWidth: true; implicitHeight: 62; radius: 7; color: "#181818"; border.color: "#444444"
                                        RowLayout {
                                            anchors.fill: parent; anchors.margins: 10
                                            ColumnLayout {
                                                Text { text: state.outputs && state.outputs.video && state.outputs.video.installed ? "OBS Studio detected" : "OBS Studio not detected"; color: "white"; font.bold: true }
                                                Text { text: "Video remains optional; Icecast audio works independently."; color: "#aaaaaa"; font.pixelSize: 12 }
                                            }
                                            Item { Layout.fillWidth: true }
                                            BlueButton { text: "Detect OBS"; onClicked: { if (window.backend) window.backend.detectObs() } }
                                        }
                                    }
                                    CheckBox { id: icecastEnabled; text: "Enable Icecast radio output"; checked: true; palette.windowText: "white" }
                                    CheckBox {
                                        id: obsEnabled; text: "Enable OBS video output"; palette.windowText: "white"
                                        enabled: obsHostField.text !== "127.0.0.1" || Boolean(state.outputs && state.outputs.video && state.outputs.video.installed)
                                    }
                                    CheckBox { id: obsAutoLaunch; text: "Launch OBS when video is requested"; enabled: obsEnabled.checked; palette.windowText: "white" }
                                    GridLayout {
                                        Layout.fillWidth: true; columns: 2; columnSpacing: 14; rowSpacing: 10
                                        SettingGroup { FieldLabel { text: "WebSocket host" } DarkField { id: obsHostField; text: "127.0.0.1" } }
                                        SettingGroup { FieldLabel { text: "WebSocket port" } DarkField { id: obsPortField; text: "4455" } }
                                        SettingGroup { FieldLabel { text: "WebSocket password" } DarkField { id: obsPasswordField; echoMode: TextInput.Password } }
                                        SettingGroup { FieldLabel { text: "OBS executable" } DarkField { id: obsPathField; placeholderText: "Detected automatically" } }
                                    }
                                    BlueButton { Layout.fillWidth: true; text: "Test OBS Connection"; onClicked: { if (window.backend) window.backend.testObs() } }
                                }
                            }

                            ColumnLayout {
                                Text { text: "Configuration Files"; color: "white"; font.pixelSize: 21; font.bold: true }
                                Text { text: "Import existing settings or export a portable JSON configuration. Passwords are excluded unless explicitly requested."; color: "#bbbbbb"; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                                RowLayout {
                                    Layout.fillWidth: true; spacing: 12
                                    BlueButton { Layout.fillWidth: true; text: "↑  Import Config"; onClicked: importDialog.open() }
                                    BlueButton { Layout.fillWidth: true; text: "↓  Export Config"; danger: true; onClicked: exportDialog.open() }
                                }
                                CheckBox { id: includeSecrets; text: "Include source and OBS passwords in export"; palette.windowText: "white" }
                                Rectangle {
                                    Layout.fillWidth: true; implicitHeight: 90; radius: 7; color: "#181818"; border.color: "#444444"
                                    Text { anchors.fill: parent; anchors.margins: 12; text: window.coreMessage; color: "#00ee32"; font.family: "Consolas"; wrapMode: Text.WrapAnywhere }
                                }
                                Item { Layout.fillHeight: true }
                            }
                        }

                        RowLayout {
                            Layout.fillWidth: true
                            Text { text: window.coreMessage; color: "#bdbdbd"; font.pixelSize: 12; elide: Text.ElideRight; Layout.fillWidth: true }
                            BlueButton { text: "Reload"; onClicked: { if (window.backend) window.backend.loadSettings() } }
                            BlueButton { text: "Save Settings"; enabled: !window.coreBusy; onClicked: window.saveSettings() }
                        }
                    }
                }
            }
        }

        Rectangle {
            radius: 12; color: "white"
            ColumnLayout {
                anchors.fill: parent; anchors.margins: 32; spacing: 16
                Text { text: "RebornBroadcaster"; color: "#222222"; font.pixelSize: 30; font.bold: true; horizontalAlignment: Text.AlignHCenter; Layout.fillWidth: true }
                Text { text: "Native broadcast controller and isolated media core"; color: "#555555"; font.pixelSize: 16; horizontalAlignment: Text.AlignHCenter; Layout.fillWidth: true }
                Rectangle { Layout.fillWidth: true; height: 3; color: window.blue }
                Text {
                    text: "RebornBroadcaster controls Icecast audio, local recording, and optional OBS video without making the interface responsible for media processing. The headless core remains available to automation and Kos controllers on localhost:8010."
                    color: "#333333"; font.pixelSize: 15; wrapMode: Text.WordWrap; Layout.fillWidth: true
                }
                Text {
                    text: "Copyright © Reborn Entertainment / ConliffeMediaGroup\nSee THIRD_PARTY_NOTICES.txt for bundled component notices."
                    color: "#666666"; font.pixelSize: 13; wrapMode: Text.WordWrap; Layout.fillWidth: true
                }
                Item { Layout.fillHeight: true }
                BlueButton { Layout.alignment: Qt.AlignHCenter; width: 180; text: "Back to Console"; onClicked: window.page = 0 }
            }
        }
    }
}
