window.addEventListener('DOMContentLoaded', () => {
    try {
        console.log("🔥 DOMContentLoaded fired!");

        const form = document.getElementById('settingsForm');
        const audioSourceSelect = document.getElementById('audioSource');
        const mountpointInput = document.getElementById('mountpoint');
        const sourcePasswordInput = document.getElementById('sourcePassword');
        const encodingTypeSelect = document.getElementById('encoding');
        const bitrateInput = document.getElementById('bitrate');
        const pathInput = document.getElementById('recordingPath');
        const browseButton = document.getElementById('browseButton');
        const icecastHostInput = document.getElementById('hostIP');
        const icecastPortInput = document.getElementById('hostPort');

        let cachedDevices = []; // Store devices to compare later

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
                if (sourcePasswordInput) sourcePasswordInput.value = settings.sourcepassword || '';
                if (icecastHostInput) icecastHostInput.value = settings.icecastHost || '';
                if (icecastPortInput) icecastPortInput.value = settings.icecastPort || '';
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
                sourcepassword: sourcePasswordInput.value.trim(),
                icecastHost: icecastHostInput.value.trim(),
                icecastPort: icecastPortInput.value.trim(),
                encodingType: encodingTypeSelect.value,
                audioSourceId: selectedDeviceId || '',
                audioSourceName: selectedDeviceName || '',
                bitrate: parseInt(bitrateInput.value),
                recordingPath: pathInput.value.trim()
            };

            try {
                await window.electron.saveSettings(settings);
                console.log('✅ Settings saved:', settings);
            } catch (error) {
                console.error('❌ Error saving settings:', error);
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

    } catch (error) {
        console.error('❌ Error in DOMContentLoaded listener:', error);
    }
});
