const ALL_LANGS = {"abk":"Abkhazian","aar":"Afar","afr":"Afrikaans","aka":"Akan","sqi":"Albanian","amh":"Amharic","ara":"Arabic","arg":"Aragonese","hye":"Armenian","asm":"Assamese","ava":"Avaric","ave":"Avestan","aym":"Aymara","aze":"Azerbaijani","bam":"Bambara","bak":"Bashkir","eus":"Basque","bel":"Belarusian","ben":"Bengali","bih":"Bihari languages","bis":"Bislama","nob":"Bokmål, Norwegian","bos":"Bosnian","bre":"Breton","bul":"Bulgarian","bur":"Burmese","cat":"Catalan","khm":"Central Khmer","cha":"Chamorro","che":"Chechen","nya":"Chichewa","chi":"Chinese","chu":"Church Slavic","chv":"Chuvash","cor":"Cornish","cos":"Corsican","cre":"Cree","hrv":"Croatian","cze":"Czech","dan":"Danish","div":"Divehi","dut":"Dutch","dzo":"Dzongkha","eng":"English","epo":"Esperanto","est":"Estonian","ewe":"Ewe","fao":"Faroese","fij":"Fijian","fin":"Finnish","fre":"French","ful":"Fulah","gla":"Gaelic","glg":"Galician","lug":"Ganda","geo":"Georgian","ger":"German","gre":"Greek","grn":"Guarani","guj":"Gujarati","hat":"Haitian","hau":"Hausa","heb":"Hebrew","her":"Herero","hin":"Hindi","hmo":"Hiri Motu","hun":"Hungarian","ice":"Icelandic","ido":"Ido","ibo":"Igbo","ind":"Indonesian","ina":"Interlingua","ile":"Interlingue","iku":"Inuktitut","ipk":"Inupiaq","gle":"Irish","ita":"Italian","jpn":"Japanese","jav":"Javanese","kal":"Kalaallisut","kan":"Kannada","kau":"Kanuri","kas":"Kashmiri","kaz":"Kazakh","kik":"Kikuyu","kin":"Kinyarwanda","kir":"Kirghiz","kom":"Komi","kon":"Kongo","kor":"Korean","kua":"Kuanyama","kur":"Kurdish","lao":"Lao","lat":"Latin","lav":"Latvian","lim":"Limburgan","lin":"Lingala","lit":"Lithuanian","lub":"Luba-Katanga","ltz":"Luxembourgish","mac":"Macedonian","mlg":"Malagasy","may":"Malay","mal":"Malayalam","mlt":"Maltese","glv":"Manx","mao":"Maori","mar":"Marathi","mah":"Marshallese","mon":"Mongolian","nau":"Nauru","nav":"Navajo","nde":"Ndebele, North","nbl":"Ndebele, South","ndo":"Ndonga","nep":"Nepali","sme":"Northern Sami","nor":"Norwegian","nno":"Norwegian Nynorsk","oci":"Occitan","oji":"Ojibwa","ori":"Oriya","orm":"Oromo","oss":"Ossetian","pli":"Pali","pan":"Panjabi","per":"Persian","pol":"Polish","por":"Portuguese","pus":"Pushto","que":"Quechua","rum":"Romanian","roh":"Romansh","run":"Rundi","rus":"Russian","smo":"Samoan","sag":"Sango","san":"Sanskrit","srd":"Sardinian","srp":"Serbian","sna":"Shona","iii":"Sichuan Yi","snd":"Sindhi","sin":"Sinhala","slo":"Slovak","slv":"Slovenian","som":"Somali","sot":"Sotho, Southern","spa":"Spanish","sun":"Sundanese","swa":"Swahili","ssw":"Swati","swe":"Swedish","tgl":"Tagalog","tah":"Tahitian","tgk":"Tajik","tam":"Tamil","tat":"Tatar","tel":"Telugu","tha":"Thai","tib":"Tibetan","tir":"Tigrinya","ton":"Tonga","tso":"Tsonga","tsn":"Tswana","tur":"Turkish","tuk":"Turkmen","twi":"Twi","uig":"Uighur","ukr":"Ukrainian","urd":"Urdu","uzb":"Uzbek","ven":"Venda","vie":"Vietnamese","vol":"Volapük","wln":"Walloon","wel":"Welsh","fry":"Western Frisian","wol":"Wolof","xho":"Xhosa","yid":"Yiddish","yor":"Yoruba","zha":"Zhuang","zul":"Zulu"};

        let configData = null;
        let logSummary = { loggingEnabled: false, devices: [] };
        let analyticsRangeDays = 30;
        let analyticsSummary = {
            overview: null,
            realtimeSockets: [],
            recentSessions: [],
            topServers: [],
            topUsers: [],
            topLibraries: [],
            trends: [],
            topItems: []
        };
        let selectedAnalyticsEntity = null;
        let selectedLogDeviceId = null;
        let selectedAnalyticsSessionId = null;
let currentDeviceLogs = [];
let autoScrollEnabled = true;
        let spokenLanguages = [];
        let tokenRevealed = false;
        let actualToken = '';
        const dirtyState = {};
        let shareDiscovery = createDefaultShareDiscoveryState();

        function createDefaultShareDiscoveryState() {
            return {
                scanning: false,
                hasScanned: false,
                error: '',
                warnings: [],
                scannedSubnets: [],
                results: [],
                smbBrowser: {
                    host: '',
                    username: '',
                    password: '',
                    domain: '',
                    loading: false,
                    hasLoaded: false,
                    error: '',
                    shares: []
                },
                nfsBrowser: {
                    host: '',
                    loading: false,
                    hasLoaded: false,
                    error: '',
                    warning: '',
                    exports: []
                }
            };
        }

        // ── Fetch wrapper: show login overlay on 401 for admin routes ──
        (function wrapFetchFor401() {
            if (typeof window === 'undefined' || !window.fetch) return;
            const nativeFetch = window.fetch.bind(window);
            window.fetch = async function(input, init) {
                const url = typeof input === 'string' ? input : (input && input.url) || '';
                const isAdmin = url.indexOf('/api/admin/') === 0;
                const response = await nativeFetch(input, init);
                if (response.status === 401 && isAdmin
                    && !/\/api\/admin\/(login|auth-check|logout)/.test(url)) {
                    var overlay = document.getElementById('login-overlay');
                    if (overlay && overlay.style.display !== 'flex') {
                        overlay.style.display = 'flex';
                        var pw = document.getElementById('login-password');
                        if (pw) { pw.value = ''; pw.focus(); }
                    }
                }
                return response;
            };
        })();

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

        function clearShareTestResult(idx) {
            var resultEl = document.getElementById('share-test-' + idx);
            if (!resultEl) return;
            resultEl.className = 'test-result';
            resultEl.textContent = '';
            resultEl.title = '';
        }

        function setShareTestResult(idx, state, message, title) {
            var resultEl = document.getElementById('share-test-' + idx);
            if (!resultEl) return;
            resultEl.className = state ? ('test-result ' + state) : 'test-result';
            resultEl.textContent = message || '';
            resultEl.title = title || '';
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

        function escapeHtml(value) {
            return String(value == null ? '' : value)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        function resetSmbBrowserResults() {
            shareDiscovery.smbBrowser.hasLoaded = false;
            shareDiscovery.smbBrowser.loading = false;
            shareDiscovery.smbBrowser.error = '';
            shareDiscovery.smbBrowser.shares = [];
        }

        function resetNfsBrowserResults() {
            shareDiscovery.nfsBrowser.hasLoaded = false;
            shareDiscovery.nfsBrowser.loading = false;
            shareDiscovery.nfsBrowser.error = '';
            shareDiscovery.nfsBrowser.warning = '';
            shareDiscovery.nfsBrowser.exports = [];
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
                var label = document.createElement('span');
                label.textContent = name;
                var removeBtn = document.createElement('span');
                removeBtn.className = 'remove';
                removeBtn.setAttribute('role', 'button');
                removeBtn.setAttribute('tabindex', '0');
                removeBtn.setAttribute('aria-label', 'Remove ' + name);
                removeBtn.textContent = '\u00D7';
                removeBtn.addEventListener('click', function() { removeSpokenLanguage(code); });
                removeBtn.addEventListener('keydown', function(e) {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        removeSpokenLanguage(code);
                    }
                });
                chip.appendChild(label);
                chip.appendChild(document.createTextNode(' '));
                chip.appendChild(removeBtn);
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
                }, 250);
            } else if (!currentActive || currentActive.id === id) {
                document.querySelectorAll('.section').forEach(function(s) { s.classList.remove('active', 'fade-out'); });
                document.getElementById(id).classList.add('active');
            }
            document.querySelectorAll('.nav-link').forEach(function(l) {
                l.classList.remove('active');
                l.removeAttribute('aria-current');
            });
            var activeLink = navEl || document.querySelector('.nav-link[data-section="' + id + '"]');
            if (activeLink) {
                activeLink.classList.add('active');
                activeLink.setAttribute('aria-current', 'page');
            }
            // Close sidebar on tablet after navigating
            var nav = document.getElementById('main-nav');
            if (nav.classList.contains('open')) nav.classList.remove('open');
            var overlay = document.getElementById('sidebar-overlay');
            if (overlay && overlay.classList.contains('open')) overlay.classList.remove('open');
            
            if (id === 'device-logs') loadDeviceLogs();
            if (id === 'analytics') loadAnalyticsOverview(true);
            if (id === 'history') loadSnapshots();
        }

        // ── Hamburger / sidebar toggle ──
        function toggleSidebar() {
            var nav = document.getElementById('main-nav');
            nav.classList.toggle('open');
            var overlay = document.getElementById('sidebar-overlay');
            if (overlay) overlay.classList.toggle('open');
            var hamburger = document.getElementById('hamburger');
            if (hamburger) {
                hamburger.setAttribute('aria-expanded', nav.classList.contains('open') ? 'true' : 'false');
            }
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

        document.addEventListener('keydown', function(e) {
            if (e.key !== 'Escape') return;
            var qr = document.getElementById('qr-fullscreen');
            if (qr && qr.style.display === 'flex') {
                closeQRFullscreen();
                e.preventDefault();
                return;
            }
            var tvModal = document.getElementById('tv-pairing-modal');
            if (tvModal && tvModal.style.display === 'flex' && typeof window.closeTvPairingModal === 'function') {
                window.closeTvPairingModal();
                e.preventDefault();
                return;
            }
            var nav = document.getElementById('main-nav');
            if (nav && nav.classList.contains('open')) {
                nav.classList.remove('open');
                var overlay = document.getElementById('sidebar-overlay');
                if (overlay) overlay.classList.remove('open');
                var hamburger = document.getElementById('hamburger');
                if (hamburger) hamburger.setAttribute('aria-expanded', 'false');
                e.preventDefault();
            }
        });

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
            var sessionCount = analyticsSummary.overview && analyticsSummary.overview.totalSessions ? analyticsSummary.overview.totalSessions : 0;
            var analyticsEl = document.getElementById('stat-analytics-sessions');
            if (analyticsEl) analyticsEl.innerText = sessionCount;
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

        async function testShare(idx) {
            var share = configData.networkShares[idx];
            var buttonEl = document.getElementById('share-test-btn-' + idx);
            var protocolLabel = share && share.protocol === 'nfs' ? 'NFS' : 'SMB';
            if (!share) return;
            if (buttonEl) buttonEl.disabled = true;
            setShareTestResult(idx, '', 'Testing...', 'Testing ' + protocolLabel + ' connection...');
            try {
                var res = await fetch('/api/admin/test-network-share', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(share)
                });
                var data = await res.json();
                if (res.ok && data.success) {
                    var detail = data.protocol === 'nfs'
                        ? (data.exportVerified ? 'export verified' : 'port reachable')
                        : (data.fileCount === 1 ? '1 item' : (data.fileCount + ' items'));
                    var title = 'Connected to ' + (data.targetPath || (data.protocol === 'nfs' ? '/' : '\\'));
                    if (Array.isArray(data.sample) && data.sample.length > 0) {
                        title += data.protocol === 'nfs'
                            ? ' | Exports: ' + data.sample.join(', ')
                            : ' | Sample: ' + data.sample.join(', ');
                    }
                    if (data.warning) title += ' | ' + data.warning;
                    setShareTestResult(idx, 'success', 'Reachable (' + detail + ')', title);
                    showToast(protocolLabel + ' share connection successful.', 'success');
                } else {
                    setShareTestResult(idx, 'fail', 'Failed', data.error || 'Unable to connect.');
                    showToast(protocolLabel + ' share test failed: ' + (data.error || 'Unknown error'), 'error');
                }
            } catch (e) {
                setShareTestResult(idx, 'fail', 'Error', 'Connection error');
                showToast(protocolLabel + ' share test error: ' + e.message, 'error');
            } finally {
                if (buttonEl) buttonEl.disabled = false;
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
                        tr.innerHTML = '<td>' + escapeHtml(time) + '</td><td>' + escapeHtml(agent) + '</td><td>' + escapeHtml(ip) + '</td>';
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

        function formatDurationMs(totalMs) {
            var ms = Number(totalMs) || 0;
            if (ms <= 0) return '0m';
            var totalSeconds = Math.round(ms / 1000);
            var hours = Math.floor(totalSeconds / 3600);
            var minutes = Math.floor((totalSeconds % 3600) / 60);
            if (hours > 0) return hours + 'h ' + minutes + 'm';
            return Math.max(1, minutes) + 'm';
        }

        function formatPercent(value) {
            var num = Number(value) || 0;
            return (num * 100).toFixed(1).replace(/\.0$/, '') + '%';
        }

        function formatTicks(ticks) {
            if (ticks == null) return 'Unknown';
            var totalSeconds = Math.round((Number(ticks) || 0) / 10000000);
            var hours = Math.floor(totalSeconds / 3600);
            var minutes = Math.floor((totalSeconds % 3600) / 60);
            var seconds = totalSeconds % 60;
            if (hours > 0) return hours + 'h ' + minutes + 'm ' + seconds + 's';
            if (minutes > 0) return minutes + 'm ' + seconds + 's';
            return seconds + 's';
        }

        function formatMetadataRuntime(metadata, fallbackTicks) {
            var ticks = metadata && metadata.runtimeTicks != null ? metadata.runtimeTicks : fallbackTicks;
            if (ticks == null) return 'Unknown runtime';
            return formatTicks(ticks);
        }

        function buildArtworkUrl(metadata) {
            if (!metadata || !metadata.serverId || !metadata.itemId || !metadata.primaryImageTag) return '';
            return '/api/admin/analytics/artwork/' + encodeURIComponent(metadata.serverId) + '/' + encodeURIComponent(metadata.itemId);
        }

        function buildMetadataLine(metadata) {
            if (!metadata) return '';
            var parts = [];
            if (metadata.seriesName) parts.push(metadata.seriesName);
            if (metadata.seasonName) parts.push(metadata.seasonName);
            if (metadata.productionYear) parts.push(String(metadata.productionYear));
            if (metadata.officialRating) parts.push(metadata.officialRating);
            if (Array.isArray(metadata.genres) && metadata.genres.length) parts.push(metadata.genres.slice(0, 2).join(', '));
            return parts.join(' • ');
        }

        function svgEscape(value) {
            return String(value || '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        function createSparkBar(value, maxValue, toneClass) {
            var width = maxValue > 0 ? Math.max(10, Math.round((value / maxValue) * 100)) : 10;
            var fillClass = 'analytics-bar-fill' + (toneClass ? ' ' + toneClass : '');
            return '<div class="analytics-bar-track"><div class="' + fillClass + '" style="width:' + width + '%;"></div></div>';
        }

        function analyticsEntityButton(type, ref, label) {
            var encodedType = encodeURIComponent(type);
            var encodedRef = encodeURIComponent(ref || '');
            return '<button type="button" class="analytics-inline-link" onclick="loadAnalyticsEntityDetail(decodeURIComponent(\'' + encodedType + '\'), decodeURIComponent(\'' + encodedRef + '\'))">' + escapeHtml(label) + '</button>';
        }

        function analyticsSessionLabel(session) {
            var parts = [];
            if (session.username) parts.push(session.username);
            if (session.serverName) parts.push(session.serverName);
            if (session.deviceId) parts.push(session.deviceId);
            return parts.join(' • ') || 'Unknown playback context';
        }

        function renderAnalyticsOverview() {
            var overview = analyticsSummary.overview || {
                totalSessions: 0,
                totalPlayDurationMs: 0,
                uniqueUsers: 0,
                uniqueLibraries: 0,
                uniqueItems: 0,
                uniqueDevices: 0,
                completionRate: 0,
                lastSessionAt: null
            };
            document.getElementById('analytics-total-sessions').textContent = String(overview.totalSessions || 0);
            document.getElementById('analytics-watch-time').textContent = formatDurationMs(overview.totalPlayDurationMs);
            document.getElementById('analytics-unique-users').textContent = String(overview.uniqueUsers || 0) + ' users';
            document.getElementById('analytics-completion-rate').textContent = 'Completion rate: ' + formatPercent(overview.completionRate || 0);
            document.getElementById('analytics-last-session').textContent = overview.lastSessionAt
                ? 'Last session: ' + new Date(overview.lastSessionAt).toLocaleString()
                : 'No sessions yet';
            var activeServers = analyticsSummary.topServers || [];
            document.getElementById('analytics-unique-footprint').textContent =
                String(activeServers.length || 0) + ' servers • ' +
                String(overview.uniqueLibraries || 0) + ' libraries • ' +
                String(overview.uniqueItems || 0) + ' items • ' +
                String(overview.uniqueDevices || 0) + ' devices';
            var rangeEl = document.getElementById('analytics-range-days');
            if (rangeEl) rangeEl.value = String(analyticsRangeDays);
            renderAnalyticsSyncStatus();
            updateStats();
        }

        function renderAnalyticsSyncStatus() {
            var sync = analyticsSummary.sync || {};
            var parts = [];
            if (sync.running) {
                parts.push('Sync in progress');
            } else {
                parts.push('Idle');
            }
            if (sync.lastSuccessAt) {
                parts.push('Last success ' + new Date(sync.lastSuccessAt).toLocaleString());
            }
            if (sync.lastRunAt) {
                parts.push('Last run ' + new Date(sync.lastRunAt).toLocaleString());
            }
            if (typeof sync.polledServers === 'number' || typeof sync.polledUsers === 'number') {
                parts.push(String(sync.polledServers || 0) + ' servers • ' + String(sync.polledUsers || 0) + ' users');
            }
            if (typeof sync.websocketConfigured === 'number' || typeof sync.websocketConnected === 'number') {
                parts.push(String(sync.websocketConnected || 0) + '/' + String(sync.websocketConfigured || 0) + ' realtime sockets');
            }
            if (typeof sync.accepted === 'number' || typeof sync.closed === 'number') {
                parts.push(String(sync.accepted || 0) + ' active updates • ' + String(sync.closed || 0) + ' closed');
            }
            if (sync.websocketLastMessageAt) {
                parts.push('Realtime last message ' + new Date(sync.websocketLastMessageAt).toLocaleString());
            }
            if (sync.lastError) {
                parts.push('Last error: ' + sync.lastError);
            }
            var el = document.getElementById('analytics-sync-status');
            if (el) {
                el.textContent = parts.join(' • ') || 'No analytics sync has run yet.';
            }
        }

        function renderRealtimeSocketStatus() {
            var socketsEl = document.getElementById('analytics-realtime-sockets');
            if (!socketsEl) return;
            var sockets = analyticsSummary.realtimeSockets || [];
            if (!sockets.length) {
                socketsEl.innerHTML = '<div class="log-meta">No realtime Jellyfin sockets are configured yet. Verify a Jellyfin user to enable live ingestion.</div>';
                return;
            }
            socketsEl.innerHTML = sockets.map(function(socket) {
                var stateClass = socket.connected ? 'connected' : (socket.state === 'reconnecting' ? 'reconnecting' : 'disconnected');
                var meta = [];
                meta.push(socket.username || 'Unknown user');
                if (socket.messageCount || socket.messageCount === 0) meta.push(String(socket.messageCount) + ' messages');
                if (socket.lastMessageAt) meta.push('Last message ' + new Date(socket.lastMessageAt).toLocaleString());
                if (socket.nextReconnectAt) meta.push('Retry ' + new Date(socket.nextReconnectAt).toLocaleString());
                if (socket.lastError) meta.push('Error: ' + socket.lastError);
                return '<div class="analytics-realtime-item">' +
                    '<div class="analytics-realtime-header">' +
                        '<div>' +
                            '<div class="analytics-ranking-title">' + escapeHtml(socket.serverName || socket.serverId || 'Unknown Server') + '</div>' +
                            '<div class="analytics-ranking-meta">' + escapeHtml(meta.join(' • ')) + '</div>' +
                        '</div>' +
                        '<div class="analytics-realtime-state ' + stateClass + '">' + escapeHtml(socket.state || 'unknown') + '</div>' +
                    '</div>' +
                '</div>';
            }).join('');
        }

        function renderAnalyticsRankings() {
            var serverEl = document.getElementById('analytics-top-servers');
            var userEl = document.getElementById('analytics-top-users');
            var libraryEl = document.getElementById('analytics-top-libraries');
            var itemsEl = document.getElementById('analytics-top-items');
            var servers = analyticsSummary.topServers || [];
            var users = analyticsSummary.topUsers || [];
            var libraries = analyticsSummary.topLibraries || [];
            var items = analyticsSummary.topItems || [];
            var maxServerDuration = servers.reduce(function(max, server) { return Math.max(max, Number(server.totalPlayDurationMs) || 0); }, 0);
            var maxUserDuration = users.reduce(function(max, user) { return Math.max(max, Number(user.totalPlayDurationMs) || 0); }, 0);
            var maxLibraryDuration = libraries.reduce(function(max, library) { return Math.max(max, Number(library.totalPlayDurationMs) || 0); }, 0);
            var maxItemDuration = items.reduce(function(max, item) { return Math.max(max, Number(item.totalPlayDurationMs) || 0); }, 0);

            if (!servers.length) {
                serverEl.innerHTML = '<div class="log-meta">No server analytics yet.</div>';
            } else {
                serverEl.innerHTML = servers.map(function(server, index) {
                    return '<div class="analytics-ranking-item">' +
                        '<div class="analytics-ranking-main">' +
                            '<div class="analytics-ranking-title">#' + (index + 1) + ' ' + escapeHtml(server.serverName || server.serverId || 'Unknown Server') + '</div>' +
                            '<div class="analytics-ranking-meta">Users: ' + escapeHtml(String(server.uniqueUsers || 0)) + ' • Libraries: ' + escapeHtml(String(server.uniqueLibraries || 0)) + ' • Items: ' + escapeHtml(String(server.uniqueItems || 0)) + '</div>' +
                            createSparkBar(Number(server.totalPlayDurationMs) || 0, maxServerDuration, 'analytics-bar-fill-server') +
                        '</div>' +
                        '<div class="analytics-ranking-value">' + escapeHtml(formatDurationMs(server.totalPlayDurationMs)) + '</div>' +
                    '</div>';
                }).join('');
            }

            if (!users.length) {
                userEl.innerHTML = '<div class="log-meta">No user analytics yet.</div>';
            } else {
                userEl.innerHTML = users.map(function(user, index) {
                    return '<div class="analytics-ranking-item">' +
                        '<div class="analytics-ranking-main">' +
                            '<div class="analytics-ranking-title">#' + (index + 1) + ' ' + analyticsEntityButton('user', user.userId || user.username, user.username || user.userId || 'Unknown User') + '</div>' +
                            '<div class="analytics-ranking-meta">Sessions: ' + escapeHtml(String(user.sessionCount || 0)) + ' • Last seen: ' + escapeHtml(user.lastSessionAt ? new Date(user.lastSessionAt).toLocaleString() : 'Unknown') + '</div>' +
                            createSparkBar(Number(user.totalPlayDurationMs) || 0, maxUserDuration, 'analytics-bar-fill-user') +
                        '</div>' +
                        '<div class="analytics-ranking-value">' + escapeHtml(formatDurationMs(user.totalPlayDurationMs)) + '</div>' +
                    '</div>';
                }).join('');
            }

            if (!libraries.length) {
                libraryEl.innerHTML = '<div class="log-meta">No library analytics yet.</div>';
            } else {
                libraryEl.innerHTML = libraries.map(function(library, index) {
                    return '<div class="analytics-ranking-item">' +
                        '<div class="analytics-ranking-main">' +
                            '<div class="analytics-ranking-title">#' + (index + 1) + ' ' + escapeHtml(library.libraryName || library.libraryId || 'Unknown Library') + '</div>' +
                            '<div class="analytics-ranking-meta">Sessions: ' + escapeHtml(String(library.sessionCount || 0)) + ' • Items: ' + escapeHtml(String(library.uniqueItems || 0)) + '</div>' +
                            createSparkBar(Number(library.totalPlayDurationMs) || 0, maxLibraryDuration, 'analytics-bar-fill-library') +
                        '</div>' +
                        '<div class="analytics-ranking-value">' + escapeHtml(formatDurationMs(library.totalPlayDurationMs)) + '</div>' +
                    '</div>';
                }).join('');
            }

            if (!items.length) {
                itemsEl.innerHTML = '<div class="log-meta">No item analytics yet.</div>';
            } else {
                itemsEl.innerHTML = items.map(function(item, index) {
                    var itemMeta = item.itemMetadata || null;
                    var extraMeta = buildMetadataLine(itemMeta);
                    return '<div class="analytics-ranking-item">' +
                        '<div class="analytics-ranking-main">' +
                            '<div class="analytics-ranking-title">#' + (index + 1) + ' ' + analyticsEntityButton('item', item.itemId || item.itemName, item.itemName || item.itemId || 'Unknown Item') + '</div>' +
                            '<div class="analytics-ranking-meta">' + escapeHtml(item.itemType || 'Unknown Type') + ' • Sessions: ' + escapeHtml(String(item.sessionCount || 0)) + ' • Users: ' + escapeHtml(String(item.uniqueUsers || 0)) + (extraMeta ? ' • ' + escapeHtml(extraMeta) : '') + '</div>' +
                            createSparkBar(Number(item.totalPlayDurationMs) || 0, maxItemDuration, 'analytics-bar-fill-item') +
                        '</div>' +
                        '<div class="analytics-ranking-value">' + escapeHtml(formatDurationMs(item.totalPlayDurationMs)) + '</div>' +
                    '</div>';
                }).join('');
            }
        }

        function renderAnalyticsTrends() {
            var trendEl = document.getElementById('analytics-trend-chart');
            var summaryEl = document.getElementById('analytics-trend-summary');
            var trends = analyticsSummary.trends || [];
            if (!trends.length) {
                trendEl.innerHTML = '<div class="log-meta">No daily trend data yet.</div>';
                if (summaryEl) {
                    summaryEl.innerHTML = '<div class="log-meta">Trend summary will appear after analytics data is collected.</div>';
                }
                return;
            }
            var width = 720;
            var height = 240;
            var paddingLeft = 46;
            var paddingRight = 18;
            var paddingTop = 18;
            var paddingBottom = 42;
            var innerWidth = width - paddingLeft - paddingRight;
            var innerHeight = height - paddingTop - paddingBottom;
            var maxDuration = trends.reduce(function(max, day) { return Math.max(max, Number(day.totalPlayDurationMs) || 0); }, 0) || 1;
            var maxSessions = trends.reduce(function(max, day) { return Math.max(max, Number(day.sessionCount) || 0); }, 0) || 1;
            var totalDuration = trends.reduce(function(total, day) { return total + (Number(day.totalPlayDurationMs) || 0); }, 0);
            var totalSessions = trends.reduce(function(total, day) { return total + (Number(day.sessionCount) || 0); }, 0);
            var busiestDay = trends.reduce(function(best, day) {
                if (!best || (Number(day.totalPlayDurationMs) || 0) > (Number(best.totalPlayDurationMs) || 0)) return day;
                return best;
            }, null);
            var stepX = trends.length > 1 ? innerWidth / (trends.length - 1) : innerWidth / 2;
            var durationPoints = [];
            var sessionBars = [];
            var labels = [];

            // Show at most ~10 x-axis labels so they don't overlap when the
            // range is large (e.g. 90/180/365 days).
            var maxLabels = 10;
            var labelStride = Math.max(1, Math.ceil(trends.length / maxLabels));
            // Bars get narrower as the range grows so they don't visually merge.
            var barHalfWidth = Math.min(10, Math.max(1.5, (stepX || innerWidth) * 0.32));

            trends.forEach(function(day, index) {
                var x = paddingLeft + (trends.length > 1 ? stepX * index : innerWidth / 2);
                var durationValue = Number(day.totalPlayDurationMs) || 0;
                var sessionValue = Number(day.sessionCount) || 0;
                var y = paddingTop + innerHeight - ((durationValue / maxDuration) * innerHeight);
                var barHeight = Math.max(4, Math.round((sessionValue / maxSessions) * innerHeight * 0.38));
                durationPoints.push(x.toFixed(2) + ',' + y.toFixed(2));
                sessionBars.push(
                    '<rect x="' + (x - barHalfWidth).toFixed(2) + '" y="' + (paddingTop + innerHeight - barHeight).toFixed(2) + '" width="' + (barHalfWidth * 2).toFixed(2) + '" height="' + barHeight.toFixed(2) + '" rx="' + Math.min(6, barHalfWidth).toFixed(2) + '" class="analytics-chart-bar">' +
                        '<title>' + svgEscape(day.day + ': ' + formatDurationMs(durationValue) + ', ' + sessionValue + ' sessions') + '</title>' +
                    '</rect>'
                );
                var showLabel = (index === 0)
                    || (index === trends.length - 1)
                    || (index % labelStride === 0);
                if (showLabel) {
                    labels.push(
                        '<text x="' + x.toFixed(2) + '" y="' + (height - 16) + '" text-anchor="middle" class="analytics-chart-label">' + svgEscape(day.day.slice(5)) + '</text>'
                    );
                }
            });

            var areaPoints = durationPoints.slice();
            areaPoints.unshift(paddingLeft + ',' + (paddingTop + innerHeight));
            areaPoints.push((paddingLeft + innerWidth) + ',' + (paddingTop + innerHeight));

            var yTicks = [0, 0.5, 1].map(function(ratio) {
                var y = paddingTop + innerHeight - (ratio * innerHeight);
                var value = formatDurationMs(maxDuration * ratio);
                return (
                    '<line x1="' + paddingLeft + '" y1="' + y.toFixed(2) + '" x2="' + (paddingLeft + innerWidth) + '" y2="' + y.toFixed(2) + '" class="analytics-chart-grid"></line>' +
                    '<text x="' + (paddingLeft - 8) + '" y="' + (y + 4).toFixed(2) + '" text-anchor="end" class="analytics-chart-axis">' + svgEscape(value) + '</text>'
                );
            }).join('');

            trendEl.innerHTML =
                '<div class="analytics-chart-shell">' +
                    '<div class="analytics-chart-legend">' +
                        '<span><span class="analytics-legend-swatch analytics-legend-watch"></span>Watch Time</span>' +
                        '<span><span class="analytics-legend-swatch analytics-legend-session"></span>Sessions</span>' +
                    '</div>' +
                    '<svg viewBox="0 0 ' + width + ' ' + height + '" class="analytics-chart-svg" role="img" aria-label="Daily watch trend chart">' +
                        yTicks +
                        sessionBars.join('') +
                        '<polygon points="' + areaPoints.join(' ') + '" class="analytics-chart-area"></polygon>' +
                        '<polyline points="' + durationPoints.join(' ') + '" class="analytics-chart-line"></polyline>' +
                        durationPoints.map(function(point, index) {
                            var coords = point.split(',');
                            var label = trends[index].day + ': ' + formatDurationMs(trends[index].totalPlayDurationMs) + ', ' + trends[index].sessionCount + ' sessions';
                            var pointRadius = trends.length > 60 ? 2.2 : (trends.length > 30 ? 3 : 4.5);
                            return '<circle cx="' + coords[0] + '" cy="' + coords[1] + '" r="' + pointRadius + '" class="analytics-chart-point"><title>' + svgEscape(label) + '</title></circle>';
                        }).join('') +
                        labels.join('') +
                    '</svg>' +
                '</div>';
            if (summaryEl) {
                summaryEl.innerHTML =
                    '<div class="analytics-chart-summary-card">' +
                        '<div class="analytics-chart-summary-label">Range Watch Time</div>' +
                        '<div class="analytics-chart-summary-value">' + escapeHtml(formatDurationMs(totalDuration)) + '</div>' +
                        '<div class="analytics-chart-summary-meta">' + escapeHtml(String(totalSessions)) + ' sessions across ' + escapeHtml(String(trends.length)) + ' days</div>' +
                    '</div>' +
                    '<div class="analytics-chart-summary-card">' +
                        '<div class="analytics-chart-summary-label">Busiest Day</div>' +
                        '<div class="analytics-chart-summary-value">' + escapeHtml(busiestDay ? busiestDay.day : 'Unknown') + '</div>' +
                        '<div class="analytics-chart-summary-meta">' + escapeHtml(busiestDay ? formatDurationMs(busiestDay.totalPlayDurationMs) + ' • ' + String(busiestDay.sessionCount || 0) + ' sessions' : 'No data') + '</div>' +
                    '</div>' +
                    '<div class="analytics-chart-summary-card">' +
                        '<div class="analytics-chart-summary-label">Daily Average</div>' +
                        '<div class="analytics-chart-summary-value">' + escapeHtml(formatDurationMs(Math.round(totalDuration / Math.max(1, trends.length)))) + '</div>' +
                        '<div class="analytics-chart-summary-meta">' + escapeHtml((totalSessions / Math.max(1, trends.length)).toFixed(1).replace(/\.0$/, '')) + ' sessions per day</div>' +
                    '</div>';
            }
        }

        function renderAnalyticsSessions() {
            var listEl = document.getElementById('analytics-session-list');
            var sessions = analyticsSummary.recentSessions || [];
            if (!sessions.length) {
                listEl.innerHTML = '<div class="log-meta">No analytics sessions have been ingested yet.</div>';
                if (!selectedAnalyticsSessionId) {
                    document.getElementById('analytics-detail-title').textContent = 'No playback session selected';
                    document.getElementById('analytics-detail-meta').textContent = 'Waiting for analytics data.';
                    document.getElementById('analytics-detail-summary').innerHTML = '';
                    document.getElementById('analytics-events').innerHTML = '<div class="log-meta">No playback events to display yet.</div>';
                }
                return;
            }

            if (!selectedAnalyticsSessionId || !sessions.some(function(session) { return session.playbackSessionId === selectedAnalyticsSessionId; })) {
                selectedAnalyticsSessionId = sessions[0].playbackSessionId;
            }

            listEl.innerHTML = sessions.map(function(session) {
                var active = session.playbackSessionId === selectedAnalyticsSessionId ? ' active' : '';
                var encodedId = encodeURIComponent(session.playbackSessionId);
                return '<button type="button" class="analytics-session-item' + active + '" onclick="selectAnalyticsSession(decodeURIComponent(\'' + encodedId + '\'))">' +
                    '<div class="analytics-session-title">' + escapeHtml(session.itemName || 'Unknown Item') + '</div>' +
                    '<div class="analytics-session-meta">' + escapeHtml(analyticsSessionLabel(session)) + '</div>' +
                    '<div class="analytics-session-meta">Watch time: ' + escapeHtml(formatDurationMs(session.playDurationMs)) + ' • Last seen: ' + escapeHtml(session.lastSeenAt ? new Date(session.lastSeenAt).toLocaleString() : 'Unknown') + '</div>' +
                '</button>';
            }).join('');
        }

        async function loadAnalyticsOverview(forceDetailRefresh) {
            try {
                var res = await fetch('/api/admin/analytics/overview?recentLimit=20&topLimit=8&trendLimit=14&days=' + encodeURIComponent(analyticsRangeDays));
                if (!res.ok) throw new Error('Unable to load analytics');
                var data = await res.json();
                analyticsRangeDays = Number(data.rangeDays) || analyticsRangeDays;
                analyticsSummary = {
                    sync: data.sync || null,
                    overview: data.overview || null,
                    realtimeSockets: Array.isArray(data.realtimeSockets) ? data.realtimeSockets : [],
                    recentSessions: Array.isArray(data.recentSessions) ? data.recentSessions : [],
                    topServers: Array.isArray(data.topServers) ? data.topServers : [],
                    topUsers: Array.isArray(data.topUsers) ? data.topUsers : [],
                    topLibraries: Array.isArray(data.topLibraries) ? data.topLibraries : [],
                    trends: Array.isArray(data.trends) ? data.trends : [],
                    topItems: Array.isArray(data.topItems) ? data.topItems : []
                };
                renderAnalyticsOverview();
                renderRealtimeSocketStatus();
                renderAnalyticsRankings();
                renderAnalyticsTrends();
                renderAnalyticsSessions();
                if (selectedAnalyticsSessionId && forceDetailRefresh !== false) {
                    await selectAnalyticsSession(selectedAnalyticsSessionId);
                }
            } catch (e) {
                document.getElementById('analytics-realtime-sockets').innerHTML = '<div class="log-meta">Could not load realtime socket status.</div>';
                document.getElementById('analytics-session-list').innerHTML = '<div class="log-meta">Could not load analytics sessions.</div>';
                document.getElementById('analytics-top-servers').innerHTML = '<div class="log-meta">Could not load server analytics.</div>';
                document.getElementById('analytics-top-users').innerHTML = '<div class="log-meta">Could not load user analytics.</div>';
                document.getElementById('analytics-top-libraries').innerHTML = '<div class="log-meta">Could not load library analytics.</div>';
                document.getElementById('analytics-top-items').innerHTML = '<div class="log-meta">Could not load item analytics.</div>';
            }
        }

        async function selectAnalyticsSession(playbackSessionId) {
            selectedAnalyticsSessionId = playbackSessionId;
            renderAnalyticsSessions();
            try {
                var res = await fetch('/api/admin/analytics/sessions/' + encodeURIComponent(playbackSessionId) + '?limit=200');
                if (!res.ok) throw new Error('Unable to load analytics session');
                var data = await res.json();
                var session = data.session || {};
                var sessionMetadata = session.itemMetadata || null;
                var events = Array.isArray(data.events) ? data.events : [];
                document.getElementById('analytics-detail-title').textContent = session.itemName || 'Unknown Item';
                document.getElementById('analytics-detail-meta').textContent = analyticsSessionLabel(session) + (sessionMetadata ? ' • ' + buildMetadataLine(sessionMetadata) : '');
                document.getElementById('analytics-detail-summary').innerHTML =
                    (sessionMetadata && sessionMetadata.primaryImageTag ? '<div class="analytics-media-hero"><img class="analytics-media-poster" src="' + buildArtworkUrl(sessionMetadata) + '" alt="' + escapeHtml(session.itemName || 'Item poster') + '"><div class="analytics-media-copy">' +
                    '<div class="analytics-media-overview">' + escapeHtml(sessionMetadata.overview || 'No overview available.') + '</div>' +
                    '</div></div>' : '') +
                    '<div class="analytics-detail-pill">Type: ' + escapeHtml(session.itemType || 'Unknown') + '</div>' +
                    '<div class="analytics-detail-pill">Method: ' + escapeHtml(session.playbackMethod || 'Unknown') + '</div>' +
                    '<div class="analytics-detail-pill">Watch Time: ' + escapeHtml(formatDurationMs(session.playDurationMs)) + '</div>' +
                    '<div class="analytics-detail-pill">Position: ' + escapeHtml(formatTicks(session.positionTicks)) + '</div>' +
                    '<div class="analytics-detail-pill">Runtime: ' + escapeHtml(formatMetadataRuntime(sessionMetadata, session.runtimeTicks)) + '</div>' +
                    '<div class="analytics-detail-pill">Completed: ' + escapeHtml(session.completed ? 'Yes' : 'No') + '</div>';

                if (!events.length) {
                    document.getElementById('analytics-events').innerHTML = '<div class="log-meta">No event timeline recorded for this session yet.</div>';
                    return;
                }

                document.getElementById('analytics-events').innerHTML = events.map(function(event) {
                    var detailParts = [];
                    var details = event.details || {};
                    Object.keys(details).slice(0, 4).forEach(function(key) {
                        detailParts.push(escapeHtml(key) + ': ' + escapeHtml(details[key]));
                    });
                    return '<div class="analytics-event-row">' +
                        '<div class="analytics-event-header">' +
                            '<span class="analytics-event-type">' + escapeHtml(event.eventType || 'progress') + '</span>' +
                            '<span class="analytics-event-time">' + escapeHtml(event.createdAt ? new Date(event.createdAt).toLocaleString() : 'Unknown') + '</span>' +
                        '</div>' +
                        '<div class="analytics-event-body">Position: ' + escapeHtml(formatTicks(event.positionTicks)) + (detailParts.length ? ' • ' + detailParts.join(' • ') : '') + '</div>' +
                    '</div>';
                }).join('');
            } catch (e) {
                document.getElementById('analytics-detail-title').textContent = 'Could not load session details';
                document.getElementById('analytics-detail-meta').textContent = playbackSessionId;
                document.getElementById('analytics-detail-summary').innerHTML = '';
                document.getElementById('analytics-events').innerHTML = '<div class="log-meta">Failed to load playback session details.</div>';
            }
        }

        async function triggerAnalyticsSync() {
            try {
                var res = await fetch('/api/admin/analytics/sync-now', { method: 'POST' });
                var data = await res.json();
                if (!res.ok || data.success === false) {
                    throw new Error((data && data.error) || 'Analytics sync failed');
                }
                showToast(data.skipped ? 'Analytics sync already running' : 'Analytics sync started', 'success');
                analyticsSummary.sync = data.sync || analyticsSummary.sync;
                renderAnalyticsSyncStatus();
                setTimeout(function() { loadAnalyticsOverview(true); }, 1200);
            } catch (e) {
                showToast('Analytics sync failed: ' + e.message, 'error');
            }
        }

        async function loadWatchHistory() {
            var tbody = document.getElementById('analytics-history-body');
            if (!tbody) return;
            try {
                var user = document.getElementById('analytics-history-user-filter').value || '';
                var item = document.getElementById('analytics-history-item-filter').value || '';
                var url = '/api/admin/analytics/history?limit=120'
                    + '&days=' + encodeURIComponent(analyticsRangeDays)
                    + '&user=' + encodeURIComponent(user)
                    + '&item=' + encodeURIComponent(item);
                var res = await fetch(url);
                if (!res.ok) throw new Error('Unable to load watch history');
                var data = await res.json();
                var history = Array.isArray(data.history) ? data.history : [];
                if (!history.length) {
                    tbody.innerHTML = '<tr><td colspan="6" style="color:var(--text-muted);text-align:center;">No watch history matches the current filters.</td></tr>';
                    return;
                }
                tbody.innerHTML = history.map(function(entry) {
                    return '<tr>' +
                        '<td>' + escapeHtml(entry.lastSeenAt ? new Date(entry.lastSeenAt).toLocaleString() : 'Unknown') + '</td>' +
                        '<td>' + analyticsEntityButton('item', entry.itemId || entry.itemName, entry.itemName || entry.itemId || 'Unknown Item') + '</td>' +
                        '<td>' + analyticsEntityButton('user', entry.userId || entry.username, entry.username || entry.userId || 'Unknown User') + '</td>' +
                        '<td>' + escapeHtml(entry.libraryName || entry.libraryId || 'Unknown Library') + '</td>' +
                        '<td>' + escapeHtml(formatDurationMs(entry.playDurationMs)) + '</td>' +
                        '<td>' + escapeHtml((entry.completed ? 'Completed' : 'In Progress') + ((entry.sessionCount || 1) > 1 ? ' • ' + entry.sessionCount + ' merged' : '')) + '</td>' +
                    '</tr>';
                }).join('');
            } catch (e) {
                tbody.innerHTML = '<tr><td colspan="6" style="color:var(--text-muted);text-align:center;">Could not load watch history.</td></tr>';
            }
        }

        function changeAnalyticsRange() {
            var rangeEl = document.getElementById('analytics-range-days');
            analyticsRangeDays = Number(rangeEl && rangeEl.value) || 30;
            loadAnalyticsOverview(true);
            loadWatchHistory();
        }

        function clearAnalyticsEntityDetail() {
            selectedAnalyticsEntity = null;
            document.getElementById('analytics-entity-title').textContent = 'Detail Drilldown';
            document.getElementById('analytics-entity-meta').textContent = 'Select a user or item from the rankings or watch history.';
            document.getElementById('analytics-entity-summary').innerHTML = '';
            document.getElementById('analytics-entity-history').innerHTML = '<div class="log-meta">No drilldown selected.</div>';
        }

        async function loadAnalyticsEntityDetail(type, ref) {
            selectedAnalyticsEntity = { type: type, ref: ref };
            try {
                var res = await fetch('/api/admin/analytics/' + encodeURIComponent(type === 'user' ? 'users' : 'items') + '/' + encodeURIComponent(ref) + '?limit=20');
                if (!res.ok) throw new Error('Unable to load drilldown');
                var data = await res.json();
                var overview = data.overview || {};
                var history = Array.isArray(data.history) ? data.history : [];
                var maxHistoryDuration = history.reduce(function(max, entry) {
                    return Math.max(max, Number(entry.playDurationMs) || 0);
                }, 0);
                if (type === 'user') {
                    document.getElementById('analytics-entity-title').textContent = overview.username || overview.userId || 'User Detail';
                    document.getElementById('analytics-entity-meta').textContent = 'User analytics drilldown';
                    document.getElementById('analytics-entity-summary').innerHTML =
                        '<div class="analytics-detail-pill">Sessions: ' + escapeHtml(String(overview.sessionCount || 0)) + '</div>' +
                        '<div class="analytics-detail-pill">Watch Time: ' + escapeHtml(formatDurationMs(overview.totalPlayDurationMs)) + '</div>' +
                        '<div class="analytics-detail-pill">Items: ' + escapeHtml(String(overview.uniqueItems || 0)) + '</div>' +
                        '<div class="analytics-detail-pill">Libraries: ' + escapeHtml(String(overview.uniqueLibraries || 0)) + '</div>';
                } else {
                    var itemMetadata = overview.itemMetadata || null;
                    document.getElementById('analytics-entity-title').textContent = overview.itemName || overview.itemId || 'Item Detail';
                    document.getElementById('analytics-entity-meta').textContent = (overview.itemType || 'Unknown Type') + ' • item analytics drilldown' + (itemMetadata ? ' • ' + buildMetadataLine(itemMetadata) : '');
                    document.getElementById('analytics-entity-summary').innerHTML =
                        (itemMetadata && itemMetadata.primaryImageTag ? '<div class="analytics-media-hero"><img class="analytics-media-poster" src="' + buildArtworkUrl(itemMetadata) + '" alt="' + escapeHtml(overview.itemName || 'Item poster') + '"><div class="analytics-media-copy">' +
                        '<div class="analytics-media-overview">' + escapeHtml(itemMetadata.overview || 'No overview available.') + '</div>' +
                        '</div></div>' : '') +
                        '<div class="analytics-detail-pill">Sessions: ' + escapeHtml(String(overview.sessionCount || 0)) + '</div>' +
                        '<div class="analytics-detail-pill">Watch Time: ' + escapeHtml(formatDurationMs(overview.totalPlayDurationMs)) + '</div>' +
                        '<div class="analytics-detail-pill">Users: ' + escapeHtml(String(overview.uniqueUsers || 0)) + '</div>' +
                        '<div class="analytics-detail-pill">Libraries: ' + escapeHtml(String(overview.uniqueLibraries || 0)) + '</div>' +
                        '<div class="analytics-detail-pill">Runtime: ' + escapeHtml(formatMetadataRuntime(itemMetadata, itemMetadata && itemMetadata.runtimeTicks)) + '</div>';
                }

                if (!history.length) {
                    document.getElementById('analytics-entity-history').innerHTML = '<div class="log-meta">No recent history for this drilldown.</div>';
                    return;
                }

                document.getElementById('analytics-entity-history').innerHTML = history.map(function(entry) {
                    return '<div class="analytics-entity-row">' +
                        '<div class="analytics-entity-row-title">' + escapeHtml(type === 'user' ? (entry.itemName || entry.itemId || 'Unknown Item') : (entry.username || entry.userId || 'Unknown User')) + '</div>' +
                        '<div class="analytics-entity-row-meta">' +
                            escapeHtml(entry.lastSeenAt ? new Date(entry.lastSeenAt).toLocaleString() : 'Unknown') +
                            ' • ' + escapeHtml(formatDurationMs(entry.playDurationMs)) +
                            ' • ' + escapeHtml(entry.libraryName || entry.libraryId || 'Unknown Library') +
                            ((entry.sessionCount || 1) > 1 ? ' • ' + escapeHtml(String(entry.sessionCount)) + ' merged' : '') +
                        '</div>' +
                        createSparkBar(Number(entry.playDurationMs) || 0, maxHistoryDuration, type === 'user' ? 'analytics-bar-fill-item' : 'analytics-bar-fill-user') +
                    '</div>';
                }).join('');
            } catch (e) {
                document.getElementById('analytics-entity-title').textContent = 'Drilldown Failed';
                document.getElementById('analytics-entity-meta').textContent = ref;
                document.getElementById('analytics-entity-summary').innerHTML = '';
                document.getElementById('analytics-entity-history').innerHTML = '<div class="log-meta">Could not load drilldown details.</div>';
            }
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
                document.getElementById('copy-logs-button').disabled = false;
                currentDeviceLogs = entries;
                document.getElementById('clear-logs-button').disabled = false;
                renderLogs();
            } catch (e) {
                document.getElementById('log-viewer-title').textContent = 'Device Logs';
                document.getElementById('log-viewer-meta').textContent = 'Could not load the selected device.';
                document.getElementById('log-viewer').textContent = 'Could not load device logs.';
                document.getElementById('download-logs-button').disabled = true;
                document.getElementById('copy-logs-button').disabled = true;
            }
        }

        function downloadSelectedLogs() {
            if (!selectedLogDeviceId) return;
            window.location.href = '/api/admin/device-logs/' + encodeURIComponent(selectedLogDeviceId) + '/download';
        }

        function buildLogsTextForCopy() {
            var search = (document.getElementById('log-search').value || '').toLowerCase();
            var filter = document.getElementById('log-level-filter').value;
            var lines = [];
            currentDeviceLogs.forEach(function(entry) {
                var level = (entry.level || '?').toUpperCase();
                if (filter !== 'ALL' && !level.includes(filter) && filter !== level) return;
                var line = (entry.timestamp || entry.receivedAt || '') + ' ' + level + '/' + (entry.tag || 'SpatialFin') + ': ' + (entry.message || '') + (entry.stack ? '\n' + entry.stack : '');
                if (search && line.toLowerCase().indexOf(search) === -1) return;
                lines.push(line);
            });
            return lines.join('\n');
        }

        async function copySelectedLogs() {
            if (!selectedLogDeviceId || !currentDeviceLogs.length) {
                showToast('No logs to copy', 'error');
                return;
            }
            var text = buildLogsTextForCopy();
            if (!text) {
                showToast('No log lines match the current filters', 'error');
                return;
            }
            var btn = document.getElementById('copy-logs-button');
            var originalLabel = btn ? btn.textContent : '';
            try {
                if (navigator.clipboard && window.isSecureContext) {
                    await navigator.clipboard.writeText(text);
                } else {
                    // Fallback for plain HTTP / older browsers.
                    var ta = document.createElement('textarea');
                    ta.value = text;
                    ta.setAttribute('readonly', '');
                    ta.style.position = 'fixed';
                    ta.style.opacity = '0';
                    document.body.appendChild(ta);
                    ta.select();
                    var ok = document.execCommand('copy');
                    document.body.removeChild(ta);
                    if (!ok) throw new Error('execCommand copy failed');
                }
                var lineCount = text.split('\n').length;
                showToast('Copied ' + lineCount + ' log line' + (lineCount === 1 ? '' : 's'), 'success');
                if (btn) {
                    btn.textContent = 'Copied!';
                    setTimeout(function() { btn.textContent = originalLabel || 'Copy Logs'; }, 1500);
                }
            } catch (err) {
                showToast('Could not copy logs: ' + (err.message || 'unknown error'), 'error');
            }
        }
        window.copySelectedLogs = copySelectedLogs;

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

        function addDiscoveredSmbShare(host, shareName) {
            if (!configData || !configData.networkShares) return;
            configData.networkShares.push({
                id: Math.random().toString(36).substr(2, 9),
                protocol: 'smb',
                host: host || '',
                shareName: shareName || '',
                path: '',
                displayName: shareName || host || 'New Share',
                username: shareDiscovery.smbBrowser.username || '',
                password: shareDiscovery.smbBrowser.password || '',
                domain: shareDiscovery.smbBrowser.domain || '',
                addedAtEpochMs: Date.now()
            });
            renderShares();
            updateStats();
            markDirty('network-shares');
            showToast('SMB share added to the configuration.', 'success');
        }

        function addDiscoveredNfsShare(host, exportPath) {
            if (!configData || !configData.networkShares) return;
            configData.networkShares.push({
                id: Math.random().toString(36).substr(2, 9),
                protocol: 'nfs',
                host: host || '',
                shareName: exportPath || '',
                path: '',
                displayName: exportPath || host || 'New Share',
                username: '',
                password: '',
                addedAtEpochMs: Date.now()
            });
            renderShares();
            updateStats();
            markDirty('network-shares');
            showToast('NFS export added to the configuration.', 'success');
        }

        async function discoverNetworkShares() {
            shareDiscovery.scanning = true;
            shareDiscovery.hasScanned = true;
            shareDiscovery.error = '';
            shareDiscovery.warnings = [];
            shareDiscovery.results = [];
            shareDiscovery.scannedSubnets = [];
            renderShareDiscoveryPanel();

            try {
                var res = await fetch('/api/admin/discover-network-shares', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({})
                });
                var data = await res.json();
                if (res.ok && data.success) {
                    shareDiscovery.results = Array.isArray(data.results) ? data.results : [];
                    shareDiscovery.warnings = Array.isArray(data.warnings) ? data.warnings : [];
                    shareDiscovery.scannedSubnets = Array.isArray(data.scannedSubnets) ? data.scannedSubnets : [];
                } else {
                    shareDiscovery.error = data.error || 'Network share discovery failed.';
                }
            } catch (e) {
                shareDiscovery.error = e.message || 'Network share discovery failed.';
            } finally {
                shareDiscovery.scanning = false;
                renderShareDiscoveryPanel();
            }
        }

        async function browseSmbServer(host) {
            if (typeof host === 'string' && host) {
                shareDiscovery.smbBrowser.host = host;
            }
            resetSmbBrowserResults();
            shareDiscovery.smbBrowser.loading = true;
            renderShareDiscoveryPanel();

            try {
                var res = await fetch('/api/admin/discover-smb-server-shares', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        host: shareDiscovery.smbBrowser.host,
                        username: shareDiscovery.smbBrowser.username,
                        password: shareDiscovery.smbBrowser.password,
                        domain: shareDiscovery.smbBrowser.domain
                    })
                });
                var data = await res.json();
                if (res.ok && data.success) {
                    shareDiscovery.smbBrowser.shares = Array.isArray(data.shares) ? data.shares : [];
                    shareDiscovery.smbBrowser.hasLoaded = true;
                } else {
                    shareDiscovery.smbBrowser.error = data.error || 'SMB share browsing failed.';
                }
            } catch (e) {
                shareDiscovery.smbBrowser.error = e.message || 'SMB share browsing failed.';
            } finally {
                shareDiscovery.smbBrowser.loading = false;
                renderShareDiscoveryPanel();
            }
        }

        async function browseNfsExports(host) {
            if (typeof host === 'string' && host) {
                shareDiscovery.nfsBrowser.host = host;
            }
            resetNfsBrowserResults();
            shareDiscovery.nfsBrowser.loading = true;
            renderShareDiscoveryPanel();

            try {
                var res = await fetch('/api/admin/discover-nfs-exports', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        host: shareDiscovery.nfsBrowser.host
                    })
                });
                var data = await res.json();
                if (res.ok && data.success) {
                    shareDiscovery.nfsBrowser.exports = Array.isArray(data.exports) ? data.exports : [];
                    shareDiscovery.nfsBrowser.warning = data.warning || '';
                    shareDiscovery.nfsBrowser.hasLoaded = true;
                } else {
                    shareDiscovery.nfsBrowser.error = data.error || 'NFS export browsing failed.';
                }
            } catch (e) {
                shareDiscovery.nfsBrowser.error = e.message || 'NFS export browsing failed.';
            } finally {
                shareDiscovery.nfsBrowser.loading = false;
                renderShareDiscoveryPanel();
            }
        }

        function renderShareDiscoveryPanel() {
            var panel = document.getElementById('share-discovery-panel');
            if (!panel) return;

            if (!configData) {
                panel.innerHTML = '';
                return;
            }

            var scanSummary = '';
            if (shareDiscovery.scannedSubnets.length > 0) {
                scanSummary = '<div class="discovery-summary">Scanned: ' + escapeHtml(shareDiscovery.scannedSubnets.join(', ')) + '</div>';
            }

            var warningHtml = '';
            if (shareDiscovery.warnings.length > 0) {
                warningHtml = '<div class="discovery-warning">' + shareDiscovery.warnings.map(function(item) {
                    return '<div>' + escapeHtml(item) + '</div>';
                }).join('') + '</div>';
            }

            var resultsHtml = '';
            if (shareDiscovery.scanning) {
                resultsHtml = '<div class="discovery-empty">Scanning the local network for SMB and NFS services...</div>';
            } else if (shareDiscovery.error) {
                resultsHtml = '<div class="discovery-error">' + escapeHtml(shareDiscovery.error) + '</div>';
            } else if (shareDiscovery.hasScanned && shareDiscovery.results.length === 0) {
                resultsHtml = '<div class="discovery-empty">No SMB servers or NFS exports were discovered automatically. You can still browse a host manually below.</div>';
            } else if (shareDiscovery.results.length > 0) {
                resultsHtml = '<div class="discovery-result-list">' + shareDiscovery.results.map(function(result) {
                    var actionHtml = '';
                    if (result.protocol === 'smb') {
                        actionHtml = '<button class="secondary" onclick=\'browseSmbServer(' + JSON.stringify(result.host || '') + ')\'>Browse Shares</button>';
                    } else if (result.shareName) {
                        actionHtml = '<button onclick=\'addDiscoveredNfsShare(' + JSON.stringify(result.host || '') + ',' + JSON.stringify(result.shareName || '') + ')\'>Add Export</button>';
                    } else {
                        actionHtml = '<button class="secondary" onclick=\'browseNfsExports(' + JSON.stringify(result.host || '') + ')\'>Browse Exports</button>';
                    }

                    return '<div class="discovery-result-card">' +
                        '<div>' +
                        '<div class="discovery-result-title">' + escapeHtml(result.shareName || result.label || result.host || '') + '</div>' +
                        '<div class="discovery-result-subtitle">' + escapeHtml(result.protocol.toUpperCase() + ' • ' + (result.host || '')) + '</div>' +
                        (result.description ? '<div class="discovery-result-meta">' + escapeHtml(result.description) + '</div>' : '') +
                        '</div>' +
                        '<div class="discovery-result-actions">' + actionHtml + '</div>' +
                        '</div>';
                }).join('') + '</div>';
            }

            var smbResultsHtml = '';
            if (shareDiscovery.smbBrowser.loading) {
                smbResultsHtml = '<div class="discovery-empty">Loading SMB shares...</div>';
            } else if (shareDiscovery.smbBrowser.error) {
                smbResultsHtml = '<div class="discovery-error">' + escapeHtml(shareDiscovery.smbBrowser.error) + '</div>';
            } else if (shareDiscovery.smbBrowser.hasLoaded && shareDiscovery.smbBrowser.shares.length === 0) {
                smbResultsHtml = '<div class="discovery-empty">No browsable SMB shares were returned for that server.</div>';
            } else if (shareDiscovery.smbBrowser.shares.length > 0) {
                smbResultsHtml = '<div class="discovery-result-list">' + shareDiscovery.smbBrowser.shares.map(function(share) {
                    return '<div class="discovery-result-card">' +
                        '<div>' +
                        '<div class="discovery-result-title">' + escapeHtml(share.name || '') + '</div>' +
                        (share.description ? '<div class="discovery-result-meta">' + escapeHtml(share.description) + '</div>' : '') +
                        '</div>' +
                        '<div class="discovery-result-actions">' +
                        '<button onclick=\'addDiscoveredSmbShare(' + JSON.stringify(shareDiscovery.smbBrowser.host || '') + ',' + JSON.stringify(share.name || '') + ')\'>Use Share</button>' +
                        '</div>' +
                        '</div>';
                }).join('') + '</div>';
            }

            var nfsResultsHtml = '';
            if (shareDiscovery.nfsBrowser.loading) {
                nfsResultsHtml = '<div class="discovery-empty">Loading NFS exports...</div>';
            } else if (shareDiscovery.nfsBrowser.error) {
                nfsResultsHtml = '<div class="discovery-error">' + escapeHtml(shareDiscovery.nfsBrowser.error) + '</div>';
            } else if (shareDiscovery.nfsBrowser.hasLoaded && shareDiscovery.nfsBrowser.exports.length === 0) {
                nfsResultsHtml = '<div class="discovery-empty">No exported NFS paths were returned for that host.</div>';
            } else if (shareDiscovery.nfsBrowser.exports.length > 0) {
                nfsResultsHtml = '<div class="discovery-result-list">' + shareDiscovery.nfsBrowser.exports.map(function(exportPath) {
                    return '<div class="discovery-result-card">' +
                        '<div>' +
                        '<div class="discovery-result-title">' + escapeHtml(exportPath) + '</div>' +
                        '<div class="discovery-result-subtitle">' + escapeHtml(shareDiscovery.nfsBrowser.host || '') + '</div>' +
                        '</div>' +
                        '<div class="discovery-result-actions">' +
                        '<button onclick=\'addDiscoveredNfsShare(' + JSON.stringify(shareDiscovery.nfsBrowser.host || '') + ',' + JSON.stringify(exportPath || '') + ')\'>Use Export</button>' +
                        '</div>' +
                        '</div>';
                }).join('') + '</div>';
            }

            panel.innerHTML =
                '<div class="card discovery-card">' +
                '<div class="discovery-header">' +
                '<div>' +
                '<div class="discovery-title">Discover Shares</div>' +
                '<div class="discovery-copy">Scan the local network, then select an SMB share or NFS export instead of typing it manually.</div>' +
                '</div>' +
                '<button onclick="discoverNetworkShares()"' + (shareDiscovery.scanning ? ' disabled' : '') + '>' + (shareDiscovery.scanning ? 'Scanning...' : 'Scan Local Network') + '</button>' +
                '</div>' +
                scanSummary +
                warningHtml +
                resultsHtml +
                '<div class="discovery-browser-grid">' +
                '<div class="discovery-browser">' +
                '<div class="discovery-browser-title">Browse SMB Server</div>' +
                '<div class="discovery-form-grid">' +
                '<div><label class="setting-label">Host / IP</label><input type="text" value="' + escapeHtml(shareDiscovery.smbBrowser.host) + '" onchange="shareDiscovery.smbBrowser.host=this.value;resetSmbBrowserResults()" style="width: 100%;"></div>' +
                '<div><label class="setting-label">Username</label><input type="text" value="' + escapeHtml(shareDiscovery.smbBrowser.username) + '" onchange="shareDiscovery.smbBrowser.username=this.value;resetSmbBrowserResults()" style="width: 100%;"></div>' +
                '<div><label class="setting-label">Password</label><input type="password" value="' + escapeHtml(shareDiscovery.smbBrowser.password) + '" onchange="shareDiscovery.smbBrowser.password=this.value;resetSmbBrowserResults()" style="width: 100%;"></div>' +
                '<div><label class="setting-label">Domain</label><input type="text" value="' + escapeHtml(shareDiscovery.smbBrowser.domain) + '" onchange="shareDiscovery.smbBrowser.domain=this.value;resetSmbBrowserResults()" style="width: 100%;"></div>' +
                '</div>' +
                '<div class="discovery-actions">' +
                '<button class="secondary" onclick="browseSmbServer()"' + ((!shareDiscovery.smbBrowser.host || shareDiscovery.smbBrowser.loading) ? ' disabled' : '') + '>' + (shareDiscovery.smbBrowser.loading ? 'Browsing...' : 'List SMB Shares') + '</button>' +
                '</div>' +
                smbResultsHtml +
                '</div>' +
                '<div class="discovery-browser">' +
                '<div class="discovery-browser-title">Browse NFS Exports</div>' +
                '<div class="discovery-form-grid single-column">' +
                '<div><label class="setting-label">Host / IP</label><input type="text" value="' + escapeHtml(shareDiscovery.nfsBrowser.host) + '" onchange="shareDiscovery.nfsBrowser.host=this.value;resetNfsBrowserResults()" style="width: 100%;"></div>' +
                '</div>' +
                '<div class="discovery-actions">' +
                '<button class="secondary" onclick="browseNfsExports()"' + ((!shareDiscovery.nfsBrowser.host || shareDiscovery.nfsBrowser.loading) ? ' disabled' : '') + '>' + (shareDiscovery.nfsBrowser.loading ? 'Browsing...' : 'List NFS Exports') + '</button>' +
                '</div>' +
                (shareDiscovery.nfsBrowser.warning ? '<div class="discovery-summary">' + escapeHtml(shareDiscovery.nfsBrowser.warning) + '</div>' : '') +
                nfsResultsHtml +
                '</div>' +
                '</div>' +
                '</div>';

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
                var protocolLabel = share.protocol === 'nfs' ? 'NFS' : 'SMB';
                var shareNameLabel = share.protocol === 'nfs' ? 'Export Path' : 'Share Name / Path';
                var testControls = '<button class="secondary" id="share-test-btn-' + idx + '" onclick="testShare(' + idx + ')">Test ' + protocolLabel + '</button>' +
                    '<span id="share-test-' + idx + '" class="test-result"></span>';
                card.innerHTML = '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">' +
                    '<input type="text" placeholder="Display Name" value="' + (share.displayName || '') + '" onchange="configData.networkShares[' + idx + '].displayName=this.value;markDirty(\'network-shares\')" style="font-weight: bold; font-size: 1.1rem; width: 300px;">' +
                    '<div style="display:flex;align-items:center;gap:8px;">' +
                    testControls +
                    '<button class="danger" onclick="removeShare(' + idx + ')">Remove</button>' +
                    '</div>' +
                    '</div>' +
                    '<div class="share-field-grid">' +
                    '<div>' +
                    '<label class="setting-label">Protocol</label>' +
                    '<select onchange="configData.networkShares[' + idx + '].protocol=this.value;renderShares();markDirty(\'network-shares\')" style="width: 100%;">' +
                    '<option value="smb" ' + (share.protocol === 'smb' ? 'selected' : '') + '>Samba (SMB)</option>' +
                    '<option value="nfs" ' + (share.protocol === 'nfs' ? 'selected' : '') + '>NFS</option>' +
                    '</select>' +
                    '</div>' +
                    '<div>' +
                    '<label class="setting-label">Host / IP</label>' +
                    '<input type="text" value="' + (share.host || '') + '" onchange="configData.networkShares[' + idx + '].host=this.value;clearShareTestResult(' + idx + ');markDirty(\'network-shares\')" style="width: 100%;">' +
                    '</div>' +
                    '<div>' +
                    '<label class="setting-label">' + shareNameLabel + '</label>' +
                    '<input type="text" value="' + (share.shareName || '') + '" onchange="configData.networkShares[' + idx + '].shareName=this.value;clearShareTestResult(' + idx + ');markDirty(\'network-shares\')" style="width: 100%;">' +
                    '</div>' +
                    '<div>' +
                    '<label class="setting-label">Subpath (Optional)</label>' +
                    '<input type="text" value="' + (share.path || '') + '" onchange="configData.networkShares[' + idx + '].path=this.value;clearShareTestResult(' + idx + ');markDirty(\'network-shares\')" style="width: 100%;">' +
                    '</div>' +
                    '<div>' +
                    '<label class="setting-label">Username</label>' +
                    '<input type="text" value="' + (share.username || '') + '" onchange="configData.networkShares[' + idx + '].username=this.value;clearShareTestResult(' + idx + ');markDirty(\'network-shares\')" style="width: 100%;">' +
                    '</div>' +
                    '<div>' +
                    '<label class="setting-label">Password</label>' +
                    '<input type="password" value="' + (share.password || '') + '" onchange="configData.networkShares[' + idx + '].password=this.value;clearShareTestResult(' + idx + ');markDirty(\'network-shares\')" style="width: 100%;">' +
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
            var rememberEl = document.getElementById('login-remember');
            var remember = !!(rememberEl && rememberEl.checked);
            var errorEl = document.getElementById('login-error');
            errorEl.style.display = 'none';
            try {
                var res = await fetch('/api/admin/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: password, remember: remember })
                });
                if (res.ok) {
                    document.getElementById('login-overlay').style.display = 'none';
                    document.getElementById('login-password').value = '';
                    await loadConfig();
                } else if (res.status === 429) {
                    errorEl.textContent = 'Too many attempts. Try again in a few minutes.';
                    errorEl.style.display = 'block';
                } else {
                    errorEl.textContent = 'Invalid password';
                    errorEl.style.display = 'block';
                }
            } catch (e) {
                errorEl.textContent = 'Connection error';
                errorEl.style.display = 'block';
            }
        }

        async function doLogout() {
            try {
                await fetch('/api/admin/logout', { method: 'POST' });
            } catch (_) {}
            window.location.reload();
        }
        window.doLogout = doLogout;

        async function loadConfig() {
            var res = await fetch('/api/admin/config');
            configData = await res.json();
            shareDiscovery = createDefaultShareDiscoveryState();

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
            renderShareDiscoveryPanel();
            renderShares();
            loadQR();
            wrapPasswordInputs();
            setupDragDrop();
            loadSyncLog();
            validateRealTimeInputs();
            await loadDeviceLogs();
            await loadAnalyticsOverview(false);
            await loadWatchHistory();
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

        async function loadAppMeta() {
            try {
                var res = await fetch('/api/meta');
                if (!res.ok) return;
                var data = await res.json();
                var el = document.getElementById('nav-version');
                if (el && data.version) el.textContent = 'v' + data.version;
            } catch (_) {}
        }

        async function init() {
            loadAppMeta();
            // Check auth
            try {
                var authRes = await fetch('/api/admin/auth-check');
                var authData = await authRes.json();
                var logoutBtn = document.getElementById('logout-button');
                if (authData.authRequired && !authData.authenticated) {
                    document.getElementById('login-overlay').style.display = 'flex';
                    document.getElementById('login-password').focus();
                    return;
                }
                if (logoutBtn && authData.authRequired) {
                    logoutBtn.style.display = 'block';
                }
            } catch (e) {
                // Auth check not available, proceed
            }
            await loadConfig();

            // Start heartbeat
            checkServerStatus();
            setInterval(checkServerStatus, 30000);
            setInterval(loadDeviceLogs, 15000);
            setInterval(function() { loadAnalyticsOverview(false); }, 30000);
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
            } else if (data.type === 'analytics_sessions_ingested') {
                loadAnalyticsOverview(false);
            } else if (data.type === 'analytics_sync_completed') {
                loadAnalyticsOverview(false);
            }
        } catch (e) {}
    };
    
    ws.onclose = () => {
        setTimeout(connectWebSocket, 5000); // Reconnect
    };
}
