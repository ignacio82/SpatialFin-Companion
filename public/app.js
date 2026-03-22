const ALL_LANGS = {"abk":"Abkhazian","aar":"Afar","afr":"Afrikaans","aka":"Akan","sqi":"Albanian","amh":"Amharic","ara":"Arabic","arg":"Aragonese","hye":"Armenian","asm":"Assamese","ava":"Avaric","ave":"Avestan","aym":"Aymara","aze":"Azerbaijani","bam":"Bambara","bak":"Bashkir","eus":"Basque","bel":"Belarusian","ben":"Bengali","bih":"Bihari languages","bis":"Bislama","nob":"Bokmål, Norwegian","bos":"Bosnian","bre":"Breton","bul":"Bulgarian","bur":"Burmese","cat":"Catalan","khm":"Central Khmer","cha":"Chamorro","che":"Chechen","nya":"Chichewa","chi":"Chinese","chu":"Church Slavic","chv":"Chuvash","cor":"Cornish","cos":"Corsican","cre":"Cree","hrv":"Croatian","cze":"Czech","dan":"Danish","div":"Divehi","dut":"Dutch","dzo":"Dzongkha","eng":"English","epo":"Esperanto","est":"Estonian","ewe":"Ewe","fao":"Faroese","fij":"Fijian","fin":"Finnish","fre":"French","ful":"Fulah","gla":"Gaelic","glg":"Galician","lug":"Ganda","geo":"Georgian","ger":"German","gre":"Greek","grn":"Guarani","guj":"Gujarati","hat":"Haitian","hau":"Hausa","heb":"Hebrew","her":"Herero","hin":"Hindi","hmo":"Hiri Motu","hun":"Hungarian","ice":"Icelandic","ido":"Ido","ibo":"Igbo","ind":"Indonesian","ina":"Interlingua","ile":"Interlingue","iku":"Inuktitut","ipk":"Inupiaq","gle":"Irish","ita":"Italian","jpn":"Japanese","jav":"Javanese","kal":"Kalaallisut","kan":"Kannada","kau":"Kanuri","kas":"Kashmiri","kaz":"Kazakh","kik":"Kikuyu","kin":"Kinyarwanda","kir":"Kirghiz","kom":"Komi","kon":"Kongo","kor":"Korean","kua":"Kuanyama","kur":"Kurdish","lao":"Lao","lat":"Latin","lav":"Latvian","lim":"Limburgan","lin":"Lingala","lit":"Lithuanian","lub":"Luba-Katanga","ltz":"Luxembourgish","mac":"Macedonian","mlg":"Malagasy","may":"Malay","mal":"Malayalam","mlt":"Maltese","glv":"Manx","mao":"Maori","mar":"Marathi","mah":"Marshallese","mon":"Mongolian","nau":"Nauru","nav":"Navajo","nde":"Ndebele, North","nbl":"Ndebele, South","ndo":"Ndonga","nep":"Nepali","sme":"Northern Sami","nor":"Norwegian","nno":"Norwegian Nynorsk","oci":"Occitan","oji":"Ojibwa","ori":"Oriya","orm":"Oromo","oss":"Ossetian","pli":"Pali","pan":"Panjabi","per":"Persian","pol":"Polish","por":"Portuguese","pus":"Pushto","que":"Quechua","rum":"Romanian","roh":"Romansh","run":"Rundi","rus":"Russian","smo":"Samoan","sag":"Sango","san":"Sanskrit","srd":"Sardinian","srp":"Serbian","sna":"Shona","iii":"Sichuan Yi","snd":"Sindhi","sin":"Sinhala","slo":"Slovak","slv":"Slovenian","som":"Somali","sot":"Sotho, Southern","spa":"Spanish","sun":"Sundanese","swa":"Swahili","ssw":"Swati","swe":"Swedish","tgl":"Tagalog","tah":"Tahitian","tgk":"Tajik","tam":"Tamil","tat":"Tatar","tel":"Telugu","tha":"Thai","tib":"Tibetan","tir":"Tigrinya","ton":"Tonga","tso":"Tsonga","tsn":"Tswana","tur":"Turkish","tuk":"Turkmen","twi":"Twi","uig":"Uighur","ukr":"Ukrainian","urd":"Urdu","uzb":"Uzbek","ven":"Venda","vie":"Vietnamese","vol":"Volapük","wln":"Walloon","wel":"Welsh","fry":"Western Frisian","wol":"Wolof","xho":"Xhosa","yid":"Yiddish","yor":"Yoruba","zha":"Zhuang","zul":"Zulu"};

        let configData = null;
        let logSummary = { loggingEnabled: false, devices: [] };
        let selectedLogDeviceId = null;
let currentDeviceLogs = [];
let autoScrollEnabled = true;
        let spokenLanguages = [];
        let tokenRevealed = false;
        let actualToken = '';
        const dirtyState = {};

        // ── Toast system ──
        function showToast(message, type) {
            type = type || 'info';
            const container = document.getElementById('toast-container');
            const toast = document.createElement('div');
            toast.className = 'toast ' + type;
            toast.textContent = message;
            container.appendChild(toast);
            setTimeout(function() {
                toast.classList.add('dismissing');
                toast.addEventListener('animationend', function() {
                    if (toast.parentNode) toast.parentNode.removeChild(toast);
                });
            }, 2700);
        }

        // ── Unsaved changes tracking ──
        function markDirty(section) {
            dirtyState[section] = true;
            var link = document.querySelector('.nav-link[data-section="' + section + '"]');
            if (link && !link.querySelector('.unsaved-dot')) {
                var dot = document.createElement('span');
                dot.className = 'unsaved-dot';
                link.appendChild(dot);
            }
        }

        function clearDirty(section) {
            delete dirtyState[section];
            var link = document.querySelector('.nav-link[data-section="' + section + '"]');
            if (link) {
                var dot = link.querySelector('.unsaved-dot');
                if (dot) dot.remove();
            }
        }

        window.addEventListener('beforeunload', function(e) {
            if (Object.keys(dirtyState).length > 0) {
                e.preventDefault();
                e.returnValue = '';
            }
        });

        // ── Form validation ──
        function validateUrl(value) {
            if (!value) return true;
            return /^https?:\/\/.+/.test(value);
        }

        function setFieldInvalid(el, msg) {
            el.classList.add('invalid');
            var existing = el.parentNode.querySelector('.field-error');
            if (!existing) {
                var err = document.createElement('small');
                err.className = 'field-error';
                err.textContent = msg;
                el.parentNode.appendChild(err);
            }
        }

        function clearFieldInvalid(el) {
            el.classList.remove('invalid');
            var existing = el.parentNode.querySelector('.field-error');
            if (existing) existing.remove();
        }

        // ── Language selects ──
        function populateLanguageSelect(selectId) {
            var select = document.getElementById(selectId);
            if (!select) return;
            select.innerHTML = '<option value="">(None)</option>';
            Object.entries(ALL_LANGS).forEach(function(entry) {
                var code = entry[0], name = entry[1];
                var opt = document.createElement('option');
                opt.value = code;
                opt.innerText = name;
                select.appendChild(opt);
            });
        }

        function renderSpokenLanguages() {
            var list = document.getElementById('spoken-langs-list');
            list.innerHTML = "";
            spokenLanguages.forEach(function(code) {
                var name = ALL_LANGS[code] || code.toUpperCase();
                var chip = document.createElement('div');
                chip.className = "lang-chip";
                chip.innerHTML = '<span>' + name + '</span> <span class="remove" onclick="removeSpokenLanguage(\'' + code + '\')">&#215;</span>';
                list.appendChild(chip);
            });
            document.getElementById('pref_smart_spoken_languages').value = spokenLanguages.join(',');
        }

        function addSpokenLanguage() {
            var select = document.getElementById('add-lang-select');
            var code = select.value;
            if (code && !spokenLanguages.includes(code)) {
                spokenLanguages.push(code);
                renderSpokenLanguages();
                markDirty('global-settings');
            }
        }

        function removeSpokenLanguage(code) {
            spokenLanguages = spokenLanguages.filter(function(c) { return c !== code; });
            renderSpokenLanguages();
            markDirty('global-settings');
        }

        // ── Password toggle ──
        function wrapPasswordInputs() {
            document.querySelectorAll('input[type="password"]').forEach(function(input) {
                if (input.parentNode.classList.contains('password-wrapper')) return;
                if (input.id === 'login-password') return;
                var wrapper = document.createElement('span');
                wrapper.className = 'password-wrapper';
                input.parentNode.insertBefore(wrapper, input);
                wrapper.appendChild(input);
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'password-toggle';
                btn.textContent = '\u2299';
                btn.onclick = function() {
                    if (input.type === 'password') {
                        input.type = 'text';
                        btn.textContent = '\u2298';
                    } else {
                        input.type = 'password';
                        btn.textContent = '\u2299';
                    }
                };
                wrapper.appendChild(btn);
            });
        }

        // ── Section transitions ──
        function showSection(id, navEl) {
            var currentActive = document.querySelector('.section.active');
            if (currentActive && currentActive.id !== id) {
                currentActive.classList.add('fade-out');
                setTimeout(function() {
                    currentActive.classList.remove('active', 'fade-out');
                    var target = document.getElementById(id);
                    target.classList.add('active');
                }, 150);
            } else if (!currentActive || currentActive.id === id) {
                document.querySelectorAll('.section').forEach(function(s) { s.classList.remove('active', 'fade-out'); });
                document.getElementById(id).classList.add('active');
            }
            document.querySelectorAll('.nav-link').forEach(function(l) { l.classList.remove('active'); });
            if (navEl) {
                navEl.classList.add('active');
            } else {
                var link = document.querySelector('.nav-link[data-section="' + id + '"]');
                if (link) link.classList.add('active');
            }
            // Close sidebar on tablet after navigating
            var nav = document.getElementById('main-nav');
            if (nav.classList.contains('open')) nav.classList.remove('open');
            var overlay = document.getElementById('sidebar-overlay');
            if (overlay && overlay.classList.contains('open')) overlay.classList.remove('open');
            
            if (id === 'device-logs') loadDeviceLogs();
            if (id === 'history') loadSnapshots();
        }

        // ── Hamburger / sidebar toggle ──
        function toggleSidebar() {
            var nav = document.getElementById('main-nav');
            nav.classList.toggle('open');
            var overlay = document.getElementById('sidebar-overlay');
            if (overlay) overlay.classList.toggle('open');
        }

        // ── QR ──
        async function loadQR() {
            try {
                var res = await fetch('/api/admin/qr?host=' + window.location.hostname);
                var data = await res.json();
                document.getElementById('qr-image').src = data.qr;
                document.getElementById('qr-payload-text').innerText = "Discovery URL: " + JSON.parse(data.payload).companion_url;
            } catch (e) {
                document.getElementById('qr-payload-text').innerText = "Could not load QR code.";
            }
        }

        function showQRFullscreen() {
            var src = document.getElementById('qr-image').src;
            if (!src) return;
            document.getElementById('qr-fullscreen-image').src = src;
            document.getElementById('qr-fullscreen').style.display = 'flex';
        }

        function closeQRFullscreen() {
            document.getElementById('qr-fullscreen').style.display = 'none';
        }

        // ── Token management ──
        function toggleTokenVisibility() {
            var el = document.getElementById('token-text');
            if (tokenRevealed) {
                el.textContent = '\u25CF\u25CF\u25CF\u25CF\u25CF\u25CF\u25CF\u25CF';
                tokenRevealed = false;
            } else {
                el.textContent = actualToken || '(no token)';
                tokenRevealed = true;
            }
        }

        async function rotateToken() {
            try {
                var res = await fetch('/api/admin/rotate-token', { method: 'POST' });
                var data = await res.json();
                if (data.setup_token) {
                    actualToken = data.setup_token;
                    tokenRevealed = false;
                    document.getElementById('token-text').textContent = '\u25CF\u25CF\u25CF\u25CF\u25CF\u25CF\u25CF\u25CF';
                    showToast('Token rotated successfully', 'success');
                    loadQR();
                } else {
                    showToast('Failed to rotate token', 'error');
                }
            } catch (e) {
                showToast('Error rotating token: ' + e.message, 'error');
            }
        }

        // ── Stats ──
        function updateStats() {
            document.getElementById('stat-servers').innerText = configData.servers.length;
            var userCount = 0;
            configData.servers.forEach(function(s) { userCount += s.users.length; });
            document.getElementById('stat-users').innerText = userCount;
            document.getElementById('stat-shares').innerText = configData.networkShares.length;
            document.getElementById('stat-devices').innerText = (logSummary.devices || []).length;
        }

        // ── Server status heartbeat ──
        async function checkServerStatus() {
            var dot = document.getElementById('server-status-dot');
            var text = document.getElementById('server-status-text');
            try {
                var res = await fetch('/api/admin/auth-check');
                if (res.ok) {
                    dot.className = 'connection-dot online';
                    text.textContent = 'Online';
                } else {
                    dot.className = 'connection-dot offline';
                    text.textContent = 'Unreachable';
                }
            } catch (e) {
                dot.className = 'connection-dot offline';
                text.textContent = 'Offline';
            }
        }

        // ── Connection testing ──
        async function testJellyfin(sIdx) {
            var resultEl = document.getElementById('jellyfin-test-' + sIdx);
            resultEl.className = 'test-result';
            resultEl.textContent = 'Testing...';
            try {
                var url = configData.servers[sIdx].addresses[0];
                var res = await fetch('/api/admin/test-jellyfin', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: url })
                });
                var data = await res.json();
                if (res.ok && data.success) {
                    resultEl.className = 'test-result success';
                    resultEl.textContent = '\u2714 Connected';
                } else {
                    resultEl.className = 'test-result fail';
                    resultEl.textContent = '\u2718 ' + (data.error || 'Failed');
                }
            } catch (e) {
                resultEl.className = 'test-result fail';
                resultEl.textContent = '\u2718 Error';
            }
        }

        async function testSeerr() {
            var resultEl = document.getElementById('seerr-test-result');
            resultEl.className = 'test-result';
            resultEl.textContent = 'Testing...';
            try {
                var url = document.getElementById('pref_seerr_url').value;
                var apiKey = document.getElementById('pref_seerr_api_key').value;
                var res = await fetch('/api/admin/test-seerr', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: url, apiKey: apiKey })
                });
                var data = await res.json();
                if (res.ok && data.success) {
                    resultEl.className = 'test-result success';
                    resultEl.textContent = '\u2714 Connected';
                } else {
                    resultEl.className = 'test-result fail';
                    resultEl.textContent = '\u2718 ' + (data.error || 'Failed');
                }
            } catch (e) {
                resultEl.className = 'test-result fail';
                resultEl.textContent = '\u2718 Error';
            }
        }

        // ── User verification ──
        async function verifyUser(sIdx, uIdx) {
            try {
                var server = configData.servers[sIdx];
                var user = server.users[uIdx];
                var res = await fetch('/api/admin/verify-user', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        serverUrl: server.addresses[0],
                        username: user.username,
                        password: user.password
                    })
                });
                var data = await res.json();
                if (data.success && data.accessToken) {
                    configData.servers[sIdx].users[uIdx].access_token = data.accessToken;
                    renderUsers(sIdx);
                    showToast('User verified successfully', 'success');
                } else {
                    showToast('Verification failed: ' + (data.error || 'Unknown error'), 'error');
                }
            } catch (e) {
                showToast('Error verifying user: ' + e.message, 'error');
            }
        }

        // ── Config export/import ──
        function exportConfig() {
            var a = document.createElement('a');
            a.href = '/api/admin/config/export';
            a.download = 'spatialfin-config.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        }

        function handleImportFile(file) {
            if (!file) return;
            var reader = new FileReader();
            reader.onload = async function(e) {
                try {
                    var imported = JSON.parse(e.target.result);
                    var res = await fetch('/api/admin/config/import', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(imported)
                    });
                    if (res.ok) {
                        showToast('Config imported successfully. Reloading...', 'success');
                        setTimeout(function() { window.location.reload(); }, 1500);
                    } else {
                        showToast('Import failed', 'error');
                    }
                } catch (err) {
                    showToast('Invalid config file: ' + err.message, 'error');
                }
            };
            reader.readAsText(file);
        }

        // ── Drag-drop zone setup ──
        function setupDragDrop() {
            var zone = document.getElementById('import-drop-zone');
            if (!zone) return;
            zone.addEventListener('click', function() {
                document.getElementById('import-file-input').click();
            });
            zone.addEventListener('dragover', function(e) {
                e.preventDefault();
                zone.classList.add('dragover');
            });
            zone.addEventListener('dragleave', function(e) {
                e.preventDefault();
                zone.classList.remove('dragover');
            });
            zone.addEventListener('drop', function(e) {
                e.preventDefault();
                zone.classList.remove('dragover');
                if (e.dataTransfer.files.length > 0) {
                    handleImportFile(e.dataTransfer.files[0]);
                }
            });
        }

        // ── Sync log ──
        async function loadSyncLog() {
            var tbody = document.getElementById('sync-table-body');
            try {
                var res = await fetch('/api/admin/sync-log');
                var data = await res.json();
                if (data && data.length > 0) {
                    tbody.innerHTML = '';
                    data.forEach(function(entry) {
                        var tr = document.createElement('tr');
                        var time = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : '-';
                        var agent = entry.userAgent || '-';
                        var ip = entry.ip || '-';
                        tr.innerHTML = '<td>' + time + '</td><td>' + agent + '</td><td>' + ip + '</td>';
                        tbody.appendChild(tr);
                    });
                } else {
                    tbody.innerHTML = '<tr><td colspan="3" style="color:var(--text-muted);text-align:center;">No sync events yet.</td></tr>';
                }
            } catch (e) {
                tbody.innerHTML = '<tr><td colspan="3" style="color:var(--text-muted);text-align:center;">Could not load sync log.</td></tr>';
            }
        }

        function escapeHtml(value) {
            return String(value || '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        function renderDeviceLogList() {
            var summaryEl = document.getElementById('device-logs-summary');
            var listEl = document.getElementById('log-device-list');
            var devices = logSummary.devices || [];
            summaryEl.textContent = logSummary.loggingEnabled
                ? 'Remote device logging is enabled for SpatialFin.'
                : 'Remote device logging is currently disabled in global settings.';
            if (devices.length === 0) {
                listEl.innerHTML = '<div class="log-meta">No SpatialFin devices have uploaded logs yet.</div>';
                document.getElementById('download-logs-button').disabled = true;
                document.getElementById('clear-logs-button').disabled = true;
                if (!selectedLogDeviceId) {
                    document.getElementById('log-viewer-title').textContent = 'No device selected';
                    document.getElementById('log-viewer-meta').textContent = 'Waiting for a headset to upload logs.';
                    document.getElementById('log-viewer').textContent = 'Enable companion logging, sync a headset, then return here to inspect its log stream.';
                }
                return;
            }
            if (!selectedLogDeviceId || !devices.some(function(device) { return device.deviceId === selectedLogDeviceId; })) {
                selectedLogDeviceId = devices[0].deviceId;
            }
            listEl.innerHTML = '';
            devices.forEach(function(device) {
                var item = document.createElement('button');
                item.type = 'button';
                item.className = 'log-device-item' + (device.deviceId === selectedLogDeviceId ? ' active' : '');
                item.onclick = function() { selectLogDevice(device.deviceId); };
                item.innerHTML =
                    '<div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;">' +
                        '<div>' +
                            '<div style="font-weight:600;">' + escapeHtml(device.deviceName || device.deviceId) + '</div>' +
                            '<div class="log-meta">' + escapeHtml(device.appVersion || 'Unknown app version') + '</div>' +
                        '</div>' +
                        '<div class="log-meta">' + escapeHtml(String(device.entryCount || 0)) + ' lines</div>' +
                    '</div>' +
                    '<div class="log-meta" style="margin-top:10px;">Last upload: ' + escapeHtml(device.latestEntryAt ? new Date(device.latestEntryAt).toLocaleString() : 'Unknown') + '</div>';
                listEl.appendChild(item);
            });
        }

        async function loadDeviceLogs() {
            try {
                var res = await fetch('/api/admin/device-logs');
                var data = await res.json();
                logSummary = {
                    loggingEnabled: !!data.loggingEnabled,
                    devices: Array.isArray(data.devices) ? data.devices : []
                };
                renderDeviceLogList();
                updateStats();
                if (selectedLogDeviceId) {
                    await selectLogDevice(selectedLogDeviceId);
                }
            } catch (e) {
                document.getElementById('device-logs-summary').textContent = 'Could not load device logs.';
                document.getElementById('log-device-list').innerHTML = '<div class="log-meta">Could not load device logs.</div>';
            }
        }

        async function selectLogDevice(deviceId) {
            selectedLogDeviceId = deviceId;
            renderDeviceLogList();
            try {
                var res = await fetch('/api/admin/device-logs/' + encodeURIComponent(deviceId) + '?limit=800');
                if (!res.ok) throw new Error('Unable to load device logs');
                var data = await res.json();
                var device = data.device || {};
                var entries = Array.isArray(data.entries) ? data.entries : [];
                var meta = [];
                meta.push(device.appVersion || 'Unknown version');
                if (device.model) meta.push(device.model);
                if (device.lastSeenAt) meta.push('Last seen ' + new Date(device.lastSeenAt).toLocaleString());
                document.getElementById('log-viewer-title').textContent = device.deviceName || device.deviceId || 'Device Logs';
                document.getElementById('log-viewer-meta').textContent = meta.join(' • ');
                document.getElementById('download-logs-button').disabled = false;
                currentDeviceLogs = entries;
   document.getElementById('clear-logs-button').disabled = false;
   renderLogs();
            } catch (e) {
                document.getElementById('log-viewer-title').textContent = 'Device Logs';
                document.getElementById('log-viewer-meta').textContent = 'Could not load the selected device.';
                document.getElementById('log-viewer').textContent = 'Could not load device logs.';
                document.getElementById('download-logs-button').disabled = true;
            }
        }

        function downloadSelectedLogs() {
            if (!selectedLogDeviceId) return;
            window.location.href = '/api/admin/device-logs/' + encodeURIComponent(selectedLogDeviceId) + '/download';
        }

        // ── Render servers ──
        function renderServers() {
            var container = document.getElementById('server-container');
            container.innerHTML = "";
            if (configData.servers.length === 0) {
                container.innerHTML = '<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="7" rx="1"/><rect x="2" y="14" width="20" height="7" rx="1"/><circle cx="6" cy="6.5" r="1"/><circle cx="6" cy="17.5" r="1"/></svg><p>No servers configured yet. Click "Add Server" to get started.</p></div>';
                return;
            }
            configData.servers.forEach(function(server, sIdx) {
                var card = document.createElement('div');
                card.className = "card";
                card.innerHTML = '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">' +
                    '<input type="text" value="' + (server.name || '') + '" onchange="configData.servers[' + sIdx + '].name=this.value;markDirty(\'servers\')" style="font-weight: bold; font-size: 1.1rem; width: 300px;">' +
                    '<button class="danger" onclick="removeServer(' + sIdx + ')">Remove</button>' +
                    '</div>' +
                    '<div class="setting-row" style="gap:8px;">' +
                    '<input type="text" placeholder="Server URL (e.g. http://192.168.1.10:8096)" value="' + (server.addresses[0] || '') + '" onchange="configData.servers[' + sIdx + '].addresses=[this.value];markDirty(\'servers\')" style="flex:1;width:auto;">' +
                    '<button class="secondary" onclick="testJellyfin(' + sIdx + ')">Test</button>' +
                    '<span id="jellyfin-test-' + sIdx + '" class="test-result"></span>' +
                    '</div>' +
                    '<h4>Users</h4>' +
                    '<div id="users-' + sIdx + '"></div>' +
                    '<button class="secondary" onclick="addUser(' + sIdx + ')" style="margin-top: 10px;">+ Add User</button>';
                container.appendChild(card);
                renderUsers(sIdx);
            });
            wrapPasswordInputs();
            configData.servers.forEach((s, idx) => testJellyfinSilent(idx));
        }

        function renderUsers(sIdx) {
            var userContainer = document.getElementById('users-' + sIdx);
            userContainer.innerHTML = "";
            configData.servers[sIdx].users.forEach(function(user, uIdx) {
                var div = document.createElement('div');
                div.style = "margin-bottom: 15px; padding: 15px; background: #252525; border-radius: 8px; border-left: 4px solid var(--primary);";
                if (!user.preferences) user.preferences = {};
                var hasToken = user.access_token ? '<span class="connection-dot online" title="Verified" style="margin-left:6px;"></span>' : '';
                div.innerHTML = '<div style="display: flex; flex-direction: column; gap: 10px; margin-bottom: 15px;">' +
                    '<div style="display: flex; gap: 10px; align-items:center;">' +
                    '<input type="text" placeholder="Username" value="' + (user.username || '') + '" onchange="configData.servers[' + sIdx + '].users[' + uIdx + '].username=this.value;markDirty(\'servers\')" style="flex-grow: 1;">' +
                    '<input type="password" placeholder="Password" value="' + (user.password || '') + '" onchange="configData.servers[' + sIdx + '].users[' + uIdx + '].password=this.value;markDirty(\'servers\')" style="flex-grow: 1;">' +
                    '<button class="secondary" onclick="verifyUser(' + sIdx + ',' + uIdx + ')">Verify</button>' +
                    hasToken +
                    '<button class="danger" style="padding: 5px 12px;" onclick="removeUser(' + sIdx + ', ' + uIdx + ')">&#215;</button>' +
                    '</div>' +
                    '</div>' +
                    '<div class="user-override-panel">' +
                    '<div style="font-size: 0.9rem; font-weight: bold; margin-bottom: 10px; color: var(--primary);">User Overrides</div>' +
                    '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">' +
                    '<span>Prefer Original Language</span>' +
                    '<label class="switch">' +
                    '<input type="checkbox" ' + (user.preferences.pref_smart_prefer_original_audio === "true" ? 'checked' : '') +
                    ' onchange="configData.servers[' + sIdx + '].users[' + uIdx + '].preferences.pref_smart_prefer_original_audio = this.checked ? \'true\' : \'false\';markDirty(\'servers\')">' +
                    '<span class="slider"></span>' +
                    '</label>' +
                    '</div>' +
                    '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">' +
                    '<span>Audio Language</span>' +
                    '<select class="user-lang-select-' + sIdx + '-' + uIdx + '" data-key="pref_audio_language"></select>' +
                    '</div>' +
                    '<div style="display: flex; justify-content: space-between; align-items: center;">' +
                    '<span>Subtitle Language</span>' +
                    '<select class="user-lang-select-' + sIdx + '-' + uIdx + '" data-key="pref_subtitle_language"></select>' +
                    '</div>' +
                    '</div>';
                userContainer.appendChild(div);
                div.querySelectorAll('select.user-lang-select-' + sIdx + '-' + uIdx).forEach(function(sel) {
                    var key = sel.getAttribute('data-key');
                    sel.onchange = function(e) {
                        configData.servers[sIdx].users[uIdx].preferences[key] = e.target.value;
                        markDirty('servers');
                    };
                    sel.innerHTML = '<option value="">(Inherit Global)</option>';
                    Object.entries(ALL_LANGS).forEach(function(entry) {
                        var code = entry[0], name = entry[1];
                        var opt = document.createElement('option');
                        opt.value = code;
                        opt.innerText = name;
                        if (user.preferences[key] === code) opt.selected = true;
                        sel.appendChild(opt);
                    });
                });
            });
            wrapPasswordInputs();
        }

        function renderShares() {
            var container = document.getElementById('share-container');
            container.innerHTML = "";
            if (configData.networkShares.length === 0) {
                container.innerHTML = '<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg><p>No network shares configured yet. Click "Add Share" to get started.</p></div>';
                return;
            }
            configData.networkShares.forEach(function(share, idx) {
                var card = document.createElement('div');
                card.className = "card";
                card.innerHTML = '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">' +
                    '<input type="text" placeholder="Display Name" value="' + (share.displayName || '') + '" onchange="configData.networkShares[' + idx + '].displayName=this.value;markDirty(\'network-shares\')" style="font-weight: bold; font-size: 1.1rem; width: 300px;">' +
                    '<button class="danger" onclick="removeShare(' + idx + ')">Remove</button>' +
                    '</div>' +
                    '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">' +
                    '<div>' +
                    '<label class="setting-label">Protocol</label>' +
                    '<select onchange="configData.networkShares[' + idx + '].protocol=this.value;markDirty(\'network-shares\')" style="width: 100%;">' +
                    '<option value="smb" ' + (share.protocol === 'smb' ? 'selected' : '') + '>Samba (SMB)</option>' +
                    '<option value="nfs" ' + (share.protocol === 'nfs' ? 'selected' : '') + '>NFS</option>' +
                    '</select>' +
                    '</div>' +
                    '<div>' +
                    '<label class="setting-label">Host / IP</label>' +
                    '<input type="text" value="' + (share.host || '') + '" onchange="configData.networkShares[' + idx + '].host=this.value;markDirty(\'network-shares\')" style="width: 100%;">' +
                    '</div>' +
                    '<div>' +
                    '<label class="setting-label">Share Name / Path</label>' +
                    '<input type="text" value="' + (share.shareName || '') + '" onchange="configData.networkShares[' + idx + '].shareName=this.value;markDirty(\'network-shares\')" style="width: 100%;">' +
                    '</div>' +
                    '<div>' +
                    '<label class="setting-label">Subpath (Optional)</label>' +
                    '<input type="text" value="' + (share.path || '') + '" onchange="configData.networkShares[' + idx + '].path=this.value;markDirty(\'network-shares\')" style="width: 100%;">' +
                    '</div>' +
                    '<div>' +
                    '<label class="setting-label">Username</label>' +
                    '<input type="text" value="' + (share.username || '') + '" onchange="configData.networkShares[' + idx + '].username=this.value;markDirty(\'network-shares\')" style="width: 100%;">' +
                    '</div>' +
                    '<div>' +
                    '<label class="setting-label">Password</label>' +
                    '<input type="password" value="' + (share.password || '') + '" onchange="configData.networkShares[' + idx + '].password=this.value;markDirty(\'network-shares\')" style="width: 100%;">' +
                    '</div>' +
                    '</div>';
                container.appendChild(card);
            });
            wrapPasswordInputs();
        }

        function addServer() {
            configData.servers.push({ id: Math.random().toString(36).substr(2, 9), name: "New Jellyfin Server", addresses: [""], users: [] });
            renderServers();
            markDirty('servers');
        }

        function removeServer(idx) {
            configData.servers.splice(idx, 1);
            renderServers();
            markDirty('servers');
        }

        function addUser(sIdx) {
            configData.servers[sIdx].users.push({ username: "", password: "", preferences: {} });
            renderUsers(sIdx);
            markDirty('servers');
        }

        function removeUser(sIdx, uIdx) {
            configData.servers[sIdx].users.splice(uIdx, 1);
            renderUsers(sIdx);
            markDirty('servers');
        }

        function addShare() {
            configData.networkShares.push({
                id: Math.random().toString(36).substr(2, 9),
                protocol: "smb", host: "", shareName: "", path: "",
                displayName: "New Share", username: "", password: "", addedAtEpochMs: Date.now()
            });
            renderShares();
            markDirty('network-shares');
        }

        function removeShare(idx) {
            configData.networkShares.splice(idx, 1);
            renderShares();
            markDirty('network-shares');
        }

        // ── Save functions ──
        async function saveGlobalSettings() {
            // Validate URL fields
            var seerrUrl = document.getElementById('pref_seerr_url');
            var valid = true;
            if (seerrUrl && seerrUrl.value) {
                clearFieldInvalid(seerrUrl);
                if (!validateUrl(seerrUrl.value)) {
                    setFieldInvalid(seerrUrl, 'Must be a valid http:// or https:// URL');
                    valid = false;
                }
            }
            if (!valid) {
                showToast('Please fix validation errors before saving', 'error');
                return;
            }

            var inputs = document.querySelectorAll('#global-settings input, #global-settings select, #external-services input, #external-services select');
            inputs.forEach(function(input) {
                if (!input.id) return;
                if (input.type === 'checkbox') {
                    configData.globalPreferences[input.id] = input.checked ? "true" : "false";
                } else {
                    configData.globalPreferences[input.id] = input.value;
                }
            });
            await sync();
            showToast('Settings saved!', 'success');
            clearDirty('global-settings');
            clearDirty('external-services');
        }

        async function saveServersData() {
            await sync();
            showToast('Servers saved!', 'success');
            updateStats();
            clearDirty('servers');
        }

        async function saveSharesData() {
            await sync();
            showToast('Network shares saved!', 'success');
            updateStats();
            clearDirty('network-shares');
        }

        async function sync() {
            await fetch('/api/admin/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(configData)
            });
        }

        // ── Admin auth flow ──
        async function doLogin() {
            var password = document.getElementById('login-password').value;
            var errorEl = document.getElementById('login-error');
            errorEl.style.display = 'none';
            try {
                var res = await fetch('/api/admin/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: password })
                });
                if (res.ok) {
                    document.getElementById('login-overlay').style.display = 'none';
                    await loadConfig();
                } else {
                    errorEl.textContent = 'Invalid password';
                    errorEl.style.display = 'block';
                }
            } catch (e) {
                errorEl.textContent = 'Connection error';
                errorEl.style.display = 'block';
            }
        }

        async function loadConfig() {
            var res = await fetch('/api/admin/config');
            configData = await res.json();

            document.querySelectorAll('.lang-select').forEach(function(el) { populateLanguageSelect(el.id); });

            spokenLanguages = (configData.globalPreferences.pref_smart_spoken_languages || "").split(',').filter(function(s) { return s.trim().length > 0; });
            renderSpokenLanguages();

            for (var key in configData.globalPreferences) {
                var el = document.getElementById(key);
                if (el) {
                    if (el.type === 'checkbox') {
                        el.checked = configData.globalPreferences[key] === "true" || configData.globalPreferences[key] === true;
                    } else {
                        el.value = configData.globalPreferences[key] || "";
                    }
                }
            }

            // Load token
            if (configData.setup_token) {
                actualToken = configData.setup_token;
            }

            updateStats();
            renderServers();
            renderShares();
            loadQR();
            wrapPasswordInputs();
            setupDragDrop();
            loadSyncLog();
            validateRealTimeInputs();
            await loadDeviceLogs();
            await loadSnapshots();
            connectWebSocket();

            // Attach change listeners for dirty tracking on global-settings and external-services
            document.querySelectorAll('#global-settings input, #global-settings select').forEach(function(el) {
                el.addEventListener('change', function() { markDirty('global-settings'); });
            });
            document.querySelectorAll('#external-services input, #external-services select').forEach(function(el) {
                el.addEventListener('change', function() { markDirty('external-services'); });
            });
        }

        async function init() {
            // Check auth
            try {
                var authRes = await fetch('/api/admin/auth-check');
                var authData = await authRes.json();
                if (authData.authRequired) {
                    document.getElementById('login-overlay').style.display = 'flex';
                    document.getElementById('login-password').focus();
                    return;
                }
            } catch (e) {
                // Auth check not available, proceed
            }
            await loadConfig();

            // Start heartbeat
            checkServerStatus();
            setInterval(checkServerStatus, 30000);
            setInterval(loadDeviceLogs, 15000);
        }

        init();
        if ('serviceWorker' in navigator) { window.addEventListener('load', function() { navigator.serviceWorker.register('/sw.js'); }); }

        // -- PWA Install Prompt --
        let deferredPrompt;
        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            deferredPrompt = e;
            const installBtn = document.getElementById('install-button');
            if (installBtn) {
                installBtn.style.display = 'block';
                installBtn.addEventListener('click', async () => {
                    if (deferredPrompt) {
                        deferredPrompt.prompt();
                        const { outcome } = await deferredPrompt.userChoice;
                        if (outcome === 'accepted') {
                            installBtn.style.display = 'none';
                        }
                        deferredPrompt = null;
                    }
                });
            }
        });

        window.addEventListener('appinstalled', () => {
            const installBtn = document.getElementById('install-button');
            if (installBtn) installBtn.style.display = 'none';
        });

// -- Additional Features --

function renderLogs() {
    const viewer = document.getElementById('log-viewer');
    if (!currentDeviceLogs.length) {
        viewer.innerHTML = 'This device has uploaded metadata, but there are no log lines yet.';
        return;
    }
    const search = (document.getElementById('log-search').value || '').toLowerCase();
    const filter = document.getElementById('log-level-filter').value;
    
    let html = '';
    currentDeviceLogs.forEach(entry => {
        const level = (entry.level || '?').toUpperCase();
        if (filter !== 'ALL' && !level.includes(filter) && filter !== level) return;
        
        const line = (entry.timestamp || entry.receivedAt || '') + ' ' + level + '/' + (entry.tag || 'SpatialFin') + ': ' + (entry.message || '') + (entry.stack ? '\n' + entry.stack : '');
        if (search && !line.toLowerCase().includes(search)) return;
        
        let levelClass = 'log-level-info';
        if (level.includes('WARN')) levelClass = 'log-level-warn';
        if (level.includes('ERR')) levelClass = 'log-level-error';
        if (level.includes('FATAL')) levelClass = 'log-level-error';
        
        html += '<div class="log-line"><span class="' + levelClass + '">' + escapeHtml(level) + '</span> ' + escapeHtml((entry.timestamp || entry.receivedAt || '') + ' [' + (entry.tag || '') + '] ' + (entry.message || '')) + (entry.stack ? '<br/><pre style="margin:0;color:var(--text-muted);">' + escapeHtml(entry.stack) + '</pre>' : '') + '</div>';
    });
    
    viewer.innerHTML = html;
    if (document.getElementById('log-autoscroll').checked) {
        viewer.scrollTop = viewer.scrollHeight;
    }
}

function filterLogs() {
    renderLogs();
}

document.getElementById('log-autoscroll').addEventListener('change', (e) => {
    autoScrollEnabled = e.target.checked;
});

async function clearSelectedLogs() {
    if (!selectedLogDeviceId) return;
    if (!confirm('Are you sure you want to delete all logs for this device?')) return;
    
    try {
        const res = await fetch('/api/admin/device-logs/' + encodeURIComponent(selectedLogDeviceId), { method: 'DELETE' });
        if (res.ok) {
            showToast('Logs cleared successfully', 'success');
            currentDeviceLogs = [];
            renderLogs();
            loadDeviceLogs();
        } else {
            showToast('Failed to clear logs', 'error');
        }
    } catch (e) {
        showToast('Error clearing logs', 'error');
    }
}

function validateRealTimeInputs() {
    const seerrUrl = document.getElementById('pref_seerr_url');
    if (seerrUrl) {
        seerrUrl.addEventListener('input', () => {
            clearFieldInvalid(seerrUrl);
            if (seerrUrl.value && !validateUrl(seerrUrl.value)) {
                setFieldInvalid(seerrUrl, 'Must be a valid http:// or https:// URL');
            }
        });
    }
}

// Ensure server status is checked upon render
const originalRenderServers = renderServers;
renderServers = function() {
    originalRenderServers();
    configData.servers.forEach((s, idx) => {
        testJellyfinSilent(idx);
    });
};

async function testJellyfinSilent(sIdx) {
    var resultEl = document.getElementById('jellyfin-test-' + sIdx);
    if (!resultEl) return;
    try {
        var url = configData.servers[sIdx].addresses[0];
        if (!url) return;
        var res = await fetch('/api/admin/test-jellyfin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: url })
        });
        var data = await res.json();
        if (res.ok && data.success) {
            resultEl.className = 'connection-dot online';
            resultEl.title = 'Online';
            resultEl.textContent = '';
        } else {
            resultEl.className = 'connection-dot offline';
            resultEl.title = 'Offline';
            resultEl.textContent = '';
        }
    } catch (e) {
        resultEl.className = 'connection-dot offline';
        resultEl.title = 'Offline';
        resultEl.textContent = '';
    }
}

// -- History & Snapshots --

async function loadSnapshots() {
    var tbody = document.getElementById('snapshots-table-body');
    if (!tbody) return;
    try {
        var res = await fetch('/api/admin/config/snapshots');
        var data = await res.json();
        if (data && data.length > 0) {
            tbody.innerHTML = '';
            data.forEach(function(entry) {
                var tr = document.createElement('tr');
                var time = entry.created_at ? new Date(entry.created_at).toLocaleString() : '-';
                tr.innerHTML = '<td>' + entry.id + '</td><td>' + time + '</td><td>' + escapeHtml(entry.reason || 'unknown') + '</td><td><button class="danger" style="padding: 4px 10px; font-size: 0.8rem;" onclick="restoreSnapshot(' + entry.id + ')">Restore</button></td>';
                tbody.appendChild(tr);
            });
        } else {
            tbody.innerHTML = '<tr><td colspan="4" style="color:var(--text-muted);text-align:center;">No snapshots available.</td></tr>';
        }
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="4" style="color:var(--text-muted);text-align:center;">Could not load snapshots.</td></tr>';
    }
}

async function restoreSnapshot(id) {
    if (!confirm('Are you sure you want to restore snapshot #' + id + '? This will overwrite your current configuration.')) return;
    try {
        var res = await fetch('/api/admin/config/snapshots/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: id })
        });
        var data = await res.json();
        if (data.success) {
            showToast('Snapshot restored! Reloading...', 'success');
            setTimeout(() => window.location.reload(), 1500);
        } else {
            showToast('Failed to restore: ' + data.error, 'error');
        }
    } catch (e) {
        showToast('Error restoring snapshot', 'error');
    }
}

// 2. WebSockets

let ws;
function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(protocol + '//' + window.location.host);
    
    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.type === 'new_logs' && data.deviceId === selectedLogDeviceId) {
                // Prepend or append new logs
                currentDeviceLogs = [...data.logs, ...currentDeviceLogs];
                renderLogs();
            }
        } catch (e) {}
    };
    
    ws.onclose = () => {
        setTimeout(connectWebSocket, 5000); // Reconnect
    };
}
