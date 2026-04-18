window.addEventListener('DOMContentLoaded', () => {
    try {
        console.log("🔥 DOMContentLoaded fired!");



        const form = document.getElementById('settingsForm');
        const audioSourceSelect = document.getElementById('audioSource');
        const mountpointInput = document.getElementById('mountpoint');
        const usernameInput = document.getElementById('username');
        const sourcePasswordInput = document.getElementById('sourcePassword');
        const encodingTypeSelect = document.getElementById('encoding');
        const bitrateInput = document.getElementById('bitrate');
        const pathInput = document.getElementById('recordingPath');
        const browseButton = document.getElementById('browseButton');
        const confdownload = document.getElementById('confdownload');
        const confupload = document.getElementById('confupload');
        const icecastHostInput = document.getElementById('hostIP');
        const icecastPortInput = document.getElementById('hostPort');
        const streamNameInput = document.getElementById('streamName');
        const streamGenreInput = document.getElementById('streamGenre');
        const streamDescriptionInput = document.getElementById('streamDescription');
        const streamUrlInput = document.getElementById('streamUrl');
        const streamPublicSelect = document.getElementById('streamPublic');
        const testIcecastButton = document.getElementById('testIcecastButton');
        const icecastTestResult = document.getElementById('icecastTestResult');
        const testListenUrlButton = document.getElementById('testListenUrlButton');
        const listenUrlTestResult = document.getElementById('listenUrlTestResult');
        const nowPlayingInput = document.getElementById('nowPlaying');
        const updateNowPlayingButton = document.getElementById('updateNowPlayingButton');
        const nowPlayingResult = document.getElementById('nowPlayingResult');
        const includeSecretsCheckbox = document.getElementById('includeSecrets');
        const configResult = document.getElementById('configResult');
        const statusSnapshot = document.getElementById('statusSnapshot');
        const refreshStatusButton = document.getElementById('refreshStatusButton');

        let cachedDevices = []; // Store devices to compare later

        // Settings panels
        const tabs = Array.from(document.querySelectorAll('.settings-tab'));
        const panels = Array.from(document.querySelectorAll('.settings-panel'));

        function activatePanel(panelName) {
            tabs.forEach(t => t.classList.toggle('active', t.dataset.panel === panelName));
            panels.forEach(p => p.classList.toggle('active', p.dataset.panel === panelName));
        }

        tabs.forEach(tab => {
            tab.addEventListener('click', () => activatePanel(tab.dataset.panel));
        });

        activatePanel('stream');

        async function refreshStatus() {
            if (!statusSnapshot) return;
            statusSnapshot.textContent = 'Loading...';
            try {
                const state = await window.electron.getState();
                statusSnapshot.textContent = JSON.stringify(state, null, 2);
            } catch (err) {
                statusSnapshot.textContent = `Failed to load status: ${err?.message || err}`;
            }
        }

        refreshStatusButton?.addEventListener('click', refreshStatus);
        refreshStatus();

        // Request audio sources on page load
        if (typeof window.electron.getCachedAudioSources === 'function') {
            console.log("✅ getCachedAudioSources is defined, requesting sources...");
            window.electron.getCachedAudioSources();
        } else {
            console.error("❌ getCachedAudioSources is NOT defined in this scope!");
        }

        document.getElementById('minimizeBtn').addEventListener('click', () => {
            window.api.minimize();
        });
        
        document.getElementById('closeBtn').addEventListener('click', () => {
            window.api.close();
        });
        

        // Function to populate the audio sources dropdown
        function populateAudioSources(devices) {
            audioSourceSelect.innerHTML = ''; // Clear existing options
        
            // Add a default "Select an audio source" option
            const defaultOption = document.createElement('option');
            defaultOption.value = "";
            defaultOption.textContent = "Select an audio source";
            audioSourceSelect.appendChild(defaultOption);
        
            // Populate with the actual audio devices
            devices.forEach(device => {
                const option = document.createElement('option');
                option.value = device.id; // Store the ID as the value
                option.textContent = `[${device.id}] ${device.name}`; // Show the ID and name in the dropdown
                option.dataset.deviceName = device.name; // Store the device name as data
                audioSourceSelect.appendChild(option);
            });
        
            console.log("🎤 Audio devices populated:", devices);
        }

        

        // Load settings and pre-select the saved audio source
        const loadSettings = async () => {
            try {
                const settings = await window.electron.loadSettings();
                console.log('⚙️ Loaded settings:', settings);
        
                // Load individual settings safely
                if (mountpointInput) mountpointInput.value = settings.mountpoint || '';
                if (usernameInput) usernameInput.value = settings.username || '';
                if (sourcePasswordInput) sourcePasswordInput.value = settings.sourcepassword || '';
                if (icecastHostInput) icecastHostInput.value = settings.icecastHost || '';
                if (icecastPortInput) icecastPortInput.value = settings.icecastPort || '';
                if (streamNameInput) streamNameInput.value = settings.streamName || '';
                if (streamGenreInput) streamGenreInput.value = settings.streamGenre || '';
                if (streamDescriptionInput) streamDescriptionInput.value = settings.streamDescription || '';
                if (streamUrlInput) streamUrlInput.value = settings.streamUrl || '';
                if (streamPublicSelect) streamPublicSelect.value = String(settings.streamPublic ?? '0');
                if (nowPlayingInput) nowPlayingInput.value = settings.nowPlaying || '';
                if (encodingTypeSelect) encodingTypeSelect.value = settings.encodingType || 'mp3';
                if (bitrateInput) bitrateInput.value = settings.bitrate || 128;
                if (pathInput) pathInput.value = settings.recordingPath || '';
        
                // Ensure the audioSourceId from settings is an integer
                const audioSourceId = parseInt(settings.audioSourceId, 10);
        
                // Only update audio source if there's a valid match
                let matchedDevice = cachedDevices.find(d => d.id === audioSourceId && d.name === settings.audioSourceName);
        
                if (matchedDevice) {
                    console.log(`🎧 Setting saved audio source: [${matchedDevice.id}] ${matchedDevice.name}`);
                    audioSourceSelect.value = matchedDevice.id;
                } else {
                    console.warn("⚠️ No matching audio device found. Resetting selection.");
                    audioSourceSelect.value = ""; // Reset to blank
                }
            } catch (error) {
                console.error('❌ Error loading settings:', error);
            }
        };

        // Get the audio sources when the reply comes back
        window.electron.on('get-audio-sources-reply', (event, response) => {
            console.log("📡 Received audio sources:", response);

            if (response.error) {
                console.error("❌ Error fetching audio sources:", response.error);
                return;
            }

            cachedDevices = response.devices; // Store received devices
            populateAudioSources(response.devices);
            loadSettings(); // Load settings after populating devices
        });

        // Form submit handler to save settings
        form.addEventListener('submit', async (event) => {
            event.preventDefault();

            const selectedOption = audioSourceSelect.options[audioSourceSelect.selectedIndex];
            const selectedDeviceId = selectedOption.value;
            const selectedDeviceName = selectedOption.dataset.deviceName;

            const settings = {
                mountpoint: mountpointInput.value.trim(),
                username: usernameInput.value.trim(),
                sourcepassword: sourcePasswordInput.value.trim(),
                icecastHost: icecastHostInput.value.trim(),
                icecastPort: icecastPortInput.value.trim(),
                streamName: streamNameInput?.value?.trim() || '',
                streamGenre: streamGenreInput?.value?.trim() || '',
                streamDescription: streamDescriptionInput?.value?.trim() || '',
                streamUrl: streamUrlInput?.value?.trim() || '',
                streamPublic: streamPublicSelect?.value ?? '0',
                encodingType: encodingTypeSelect.value,
                audioSourceId: selectedDeviceId || '',
                audioSourceName: selectedDeviceName || '',
                bitrate: parseInt(bitrateInput.value),
                recordingPath: pathInput.value.trim(),
                nowPlaying: nowPlayingInput?.value?.trim() || ''
            };

            try {
                await window.electron.saveSettings(settings);
                console.log('✅ Settings saved:', settings);
            } catch (error) {
                console.error('❌ Error saving settings:', error);
            }
        });

        testIcecastButton?.addEventListener('click', async () => {
            if (icecastTestResult) icecastTestResult.textContent = 'Testing...';

            try {
                const result = await window.electron.testIcecast({
                    icecastHost: icecastHostInput?.value?.trim(),
                    icecastPort: icecastPortInput?.value?.trim(),
                    mountpoint: mountpointInput?.value?.trim(),
                });

                if (!icecastTestResult) return;

                if (!result?.ok) {
                    icecastTestResult.textContent = `FAIL: ${result?.message || 'Unknown error'}`;
                    return;
                }

                if (result.mountFound) {
                    icecastTestResult.textContent = `OK: Mount ${result.mount} online, listeners=${result.listeners}`;
                } else {
                    const mounts = Array.isArray(result.mounts) && result.mounts.length
                        ? ` (found: ${result.mounts.map(m => m.mount).join(', ')})`
                        : '';
                    icecastTestResult.textContent = `OK: Icecast reachable; mount ${result.mount} not listed in status-json${mounts}`;
                }
            } catch (err) {
                if (icecastTestResult) icecastTestResult.textContent = `FAIL: ${err?.message || err}`;
            }
        });

        testListenUrlButton?.addEventListener('click', async () => {
            if (listenUrlTestResult) listenUrlTestResult.textContent = 'Testing...';

            try {
                const result = await window.electron.testListenUrl({
                    icecastHost: icecastHostInput?.value?.trim(),
                    icecastPort: icecastPortInput?.value?.trim(),
                    mountpoint: mountpointInput?.value?.trim(),
                });

                if (!listenUrlTestResult) return;

                if (!result?.ok) {
                    listenUrlTestResult.textContent = `FAIL: ${result?.message || 'Unknown error'}`;
                    return;
                }

                const extra = result.contentType ? ` content-type=${result.contentType}` : '';
                listenUrlTestResult.textContent = `OK: ${result.url} HTTP ${result.status}${extra}`;
            } catch (err) {
                if (listenUrlTestResult) listenUrlTestResult.textContent = `FAIL: ${err?.message || err}`;
            }
        });

        updateNowPlayingButton?.addEventListener('click', async () => {
            if (nowPlayingResult) nowPlayingResult.textContent = 'Updating...';

            try {
                const result = await window.electron.updateNowPlaying({
                    icecastHost: icecastHostInput?.value?.trim(),
                    icecastPort: icecastPortInput?.value?.trim(),
                    mountpoint: mountpointInput?.value?.trim(),
                    nowPlaying: nowPlayingInput?.value?.trim(),
                });

                if (!nowPlayingResult) return;
                if (!result?.ok) {
                    nowPlayingResult.textContent = `FAIL: ${result?.message || 'Unknown error'}`;
                    return;
                }

                nowPlayingResult.textContent = 'OK: Updated';
            } catch (err) {
                if (nowPlayingResult) nowPlayingResult.textContent = `FAIL: ${err?.message || err}`;
            }
        });

        // Browse button to select a folder
        browseButton.addEventListener('click', async () => {
            try {
                const selectedFolder = await window.electron.OpenFolder();
                if (selectedFolder) pathInput.value = selectedFolder;
            } catch (error) {
                console.error("❌ Error choosing folder:", error);
            }
        });
       confupload.addEventListener('click', async () => {
        try {
            const selectedFile = await window.electron.uploadconf();
            if (selectedFile) {
            console.log('✅ Uploaded config file, now reloading settings...');
            await loadSettings(); // 👈 this reloads the form with the saved settings
            }
        } catch (error) {
            console.error("❌ Error selecting config file to upload:", error);
        }
        });


        confdownload.addEventListener('click', async () => {
            if (configResult) configResult.textContent = 'Exporting...';
            try {
                const includeSecrets = !!includeSecretsCheckbox?.checked;
                const result = await window.electron.exportConfig({ includeSecrets });
                if (configResult) {
                    configResult.textContent = result?.filePath
                        ? `OK: Exported to ${result.filePath}`
                        : 'Canceled';
                }
            } catch (error) {
                console.error("❌ Error exporting config:", error);
                if (configResult) configResult.textContent = `FAIL: ${error?.message || error}`;
            }
        });

    } catch (error) {
        console.error('❌ Error in DOMContentLoaded listener:', error);
    }

    



});
