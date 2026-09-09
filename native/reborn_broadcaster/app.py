from __future__ import annotations

import ctypes
import json
import os
import subprocess
import sys
from pathlib import Path

from PySide6.QtCore import QCoreApplication, QTimer, QUrl
from PySide6.QtGui import QAction, QIcon
from PySide6.QtNetwork import QLocalServer, QLocalSocket
from PySide6.QtQml import QQmlApplicationEngine
from PySide6.QtQuickControls2 import QQuickStyle
from PySide6.QtWidgets import QApplication, QMenu, QMessageBox, QSystemTrayIcon

from . import __version__
from .bridge import CoreBridge
from .paths import is_packaged, resource_root
from .updater_health import check_for_updates_in_background, report_candidate_health

INSTANCE_SERVER_NAME = f"RebornEntertainment.RebornBroadcaster.Controller.{__version__}"


def _notify_existing_controller() -> bool:
    connection = QLocalSocket()
    connection.connectToServer(INSTANCE_SERVER_NAME)
    if not connection.waitForConnected(750):
        return False
    connection.write(b"show\n")
    connection.flush()
    connection.waitForBytesWritten(500)
    connection.disconnectFromServer()
    return True


def _close_superseded_controllers() -> None:
    if sys.platform != "win32" or not is_packaged():
        return
    query = (
        "Get-CimInstance Win32_Process -Filter \"Name='RebornBroadcaster.exe'\" | "
        "Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress"
    )
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", query],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=10,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            check=False,
        )
        if result.returncode != 0 or not result.stdout.strip():
            return
        found = json.loads(result.stdout)
        processes = found if isinstance(found, list) else [found]
        current_path = Path(sys.executable).resolve()
        for process in processes:
            process_id = int(process.get("ProcessId") or 0)
            command_line = str(process.get("CommandLine") or "")
            executable = str(process.get("ExecutablePath") or "")
            if process_id in {0, os.getpid()} or "--core" in command_line.lower().split():
                continue
            try:
                process_path = Path(executable).resolve()
            except OSError:
                continue
            if process_path == current_path or process_path.name.lower() != "rebornbroadcaster.exe":
                continue
            subprocess.run(
                ["taskkill", "/PID", str(process_id), "/F"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                check=False,
            )
    except (OSError, ValueError, json.JSONDecodeError, subprocess.SubprocessError):
        return


def main() -> int:
    if "--core" in sys.argv:
        from .core_main import main as core_main

        sys.argv.remove("--core")
        return core_main()
    QCoreApplication.setOrganizationName("Reborn Entertainment")
    QCoreApplication.setApplicationName("RebornBroadcaster")
    if sys.platform == "win32":
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(
            "com.conliffemediagroup.rebornbroadcaster"
        )
    QQuickStyle.setStyle("Fusion")
    app = QApplication(sys.argv)
    app.setApplicationDisplayName("RebornBroadcaster")
    icon_path = resource_root() / "assets" / "KRBroadcasterIcon.png"
    if not icon_path.exists():
        icon_path = resource_root().parent / "assets" / "KRBroadcasterIcon.png"
    if icon_path.exists():
        app.setWindowIcon(QIcon(str(icon_path)))
    capture_mode = "--smoke-test" in sys.argv or "--screenshot" in sys.argv
    tray_smoke = "--tray-smoke" in sys.argv
    automated = capture_mode or tray_smoke
    instance_server = None
    if not automated:
        if _notify_existing_controller():
            return 0
        instance_server = QLocalServer(app)
        QLocalServer.removeServer(INSTANCE_SERVER_NAME)
        if not instance_server.listen(INSTANCE_SERVER_NAME):
            if _notify_existing_controller():
                return 0
            QMessageBox.critical(None, "RebornBroadcaster", "Unable to start or contact the existing RebornBroadcaster controller.")
            return 1

    if instance_server is not None:
        _close_superseded_controllers()

    bridge = CoreBridge(auto_start=not automated)
    health_reported = False

    def report_health_when_ready() -> None:
        nonlocal health_reported
        if not health_reported and bridge.connected and bridge.compatible:
            health_reported = report_candidate_health()

    bridge.connectedChanged.connect(report_health_when_ready)
    bridge.compatibleChanged.connect(report_health_when_ready)
    engine = QQmlApplicationEngine()
    engine.rootContext().setContextProperty("core", bridge)
    engine.load(QUrl.fromLocalFile(str(resource_root() / "qml" / "Main.qml")))
    if not engine.rootObjects():
        return 1
    window = engine.rootObjects()[0]
    if not automated:
        QTimer.singleShot(2500, check_for_updates_in_background)
    tray = None

    def exit_controller() -> None:
        bridge.requestExit()

    def close_window(event) -> None:
        event.setAccepted(False)
        if tray and tray.isVisible():
            window.hide()
            return
        exit_controller()

    bridge.exitReady.connect(app.quit)
    window.closing.connect(close_window)
    if not capture_mode and QSystemTrayIcon.isSystemTrayAvailable():
        app.setQuitOnLastWindowClosed(False)
        tray = QSystemTrayIcon(app.windowIcon(), app)
        tray.setToolTip("RebornBroadcaster — connecting to core")
        menu = QMenu()
        open_action = QAction("Open RebornBroadcaster", menu)
        hide_action = QAction("Hide to tray", menu)
        core_status_action = QAction("Core: connecting", menu)
        core_status_action.setEnabled(False)
        ensure_core_action = QAction("Reconnect / start core", menu)
        stop_core_action = QAction("Stop core", menu)
        stop_outputs_action = QAction("Stop streaming outputs", menu)
        exit_action = QAction("Stop core and exit RebornBroadcaster", menu)
        menu.addAction(open_action)
        menu.addAction(hide_action)
        menu.addSeparator()
        menu.addAction(core_status_action)
        menu.addAction(ensure_core_action)
        menu.addAction(stop_core_action)
        menu.addAction(stop_outputs_action)
        menu.addSeparator()
        menu.addAction(exit_action)
        tray.setContextMenu(menu)

        def show_window() -> None:
            window.show()
            window.raise_()
            window.requestActivate()

        def update_tray_status() -> None:
            status = "connected" if bridge.connected else "offline"
            core_status_action.setText(f"Core: {status}")
            tray.setToolTip(f"RebornBroadcaster — core {status}")
            stop_core_action.setEnabled(bridge.connected and not bridge.busy)
            stop_outputs_action.setEnabled(bridge.connected and bridge.activeOutputs and not bridge.busy)

        def confirm_core_stop(exit_after: bool) -> None:
            if bridge.activeOutputs:
                answer = QMessageBox.question(
                    window,
                    "Stop RebornBroadcaster core",
                    "This will stop every stream and recording before closing the core. Continue?",
                    QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                    QMessageBox.StandardButton.No,
                )
                if answer != QMessageBox.StandardButton.Yes:
                    return
            if exit_after:
                exit_controller()
            else:
                bridge.stopCore()

        open_action.triggered.connect(show_window)
        hide_action.triggered.connect(window.hide)
        ensure_core_action.triggered.connect(bridge.ensureCore)
        stop_core_action.triggered.connect(lambda: confirm_core_stop(False))
        stop_outputs_action.triggered.connect(bridge.stopLive)
        exit_action.triggered.connect(lambda: confirm_core_stop(True))
        bridge.connectedChanged.connect(update_tray_status)
        bridge.busyChanged.connect(update_tray_status)
        bridge.stateJsonChanged.connect(update_tray_status)
        tray.activated.connect(
            lambda reason: show_window()
            if reason in (QSystemTrayIcon.ActivationReason.Trigger, QSystemTrayIcon.ActivationReason.DoubleClick)
            else None
        )
        update_tray_status()
        tray.show()
    if instance_server is not None:
        def show_from_second_launch() -> None:
            while instance_server.hasPendingConnections():
                connection = instance_server.nextPendingConnection()
                if connection is not None:
                    connection.disconnectFromServer()
            window.show()
            window.raise_()
            window.requestActivate()

        instance_server.newConnection.connect(show_from_second_launch)
    if "--screenshot" in sys.argv:
        output_index = sys.argv.index("--screenshot") + 1
        output_path = sys.argv[output_index] if output_index < len(sys.argv) else "reborn-native-preview.png"

        def capture_and_quit() -> None:
            root = engine.rootObjects()[0]
            if "--screenshot-small" in sys.argv:
                root.resize(600, 500)

            def save_and_quit() -> None:
                root.grabWindow().save(output_path)
                app.quit()

            if "--screenshot-settings" in sys.argv:
                root.setProperty("page", 1)
                QTimer.singleShot(200, save_and_quit)
            elif "--screenshot-small" in sys.argv:
                QTimer.singleShot(200, save_and_quit)
            else:
                save_and_quit()

        QTimer.singleShot(900, capture_and_quit)
    elif "--smoke-test" in sys.argv or tray_smoke:
        QTimer.singleShot(900, app.quit)
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
