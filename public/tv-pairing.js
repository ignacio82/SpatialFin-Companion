(function() {
    var state = {
        step: 'home',
        sourceStep: 'home',
        mode: null,
        stream: null,
        detector: null,
        scanTimer: null,
        pendingPayload: null,
        selectedCandidate: null,
        manualCandidates: [],
        busy: false
    };

    function el(id) {
        return document.getElementById(id);
    }

    function normalizeManualCode(value) {
        return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    }

    function formatExpiry(epochMs) {
        var value = Number(epochMs);
        if (!isFinite(value) || value <= 0) return 'Unknown';
        return new Date(value).toLocaleString();
    }

    function clearTvPairingError() {
        var errorEl = el('tv-pairing-error');
        if (!errorEl) return;
        errorEl.style.display = 'none';
        errorEl.textContent = '';
    }

    function setTvPairingError(message) {
        var errorEl = el('tv-pairing-error');
        if (!errorEl) return;
        errorEl.textContent = message;
        errorEl.style.display = 'block';
    }

    function setTvPairingSubtitle(text) {
        var subtitle = el('tv-pairing-subtitle');
        if (subtitle) subtitle.textContent = text;
    }

    function renderTvPairingStatus(kind, title, message) {
        var card = el('tv-pairing-status-card');
        if (!card) return;
        var badgeClass = kind === 'success' ? 'tv-pairing-badge' : 'tv-pairing-badge';
        card.innerHTML =
            '<div class="' + badgeClass + '">' + escapeHtml(kind.toUpperCase()) + '</div>' +
            '<h3 style="margin:14px 0 8px 0;">' + escapeHtml(title) + '</h3>' +
            '<div class="tv-pairing-confirm-meta">' + escapeHtml(message) + '</div>';
    }

    function parseTvPairingQrText(text) {
        var raw = String(text || '').trim();
        if (!raw) return { ok: false, message: 'The scanned QR code was empty.' };

        var parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (_) {
            return { ok: false, message: 'That QR code is not a TV pairing payload.' };
        }

        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { ok: false, message: 'That QR code is not a TV pairing payload.' };
        }

        var receiverUrl = String(parsed.receiver_url || '').trim();
        var pairingToken = String(parsed.pairing_token || '').trim();
        var expiresAt = Number(parsed.expires_at_epoch_ms);
        if (Number(parsed.version) !== 1) {
            return { ok: false, message: 'This TV pairing QR version is not supported.' };
        }
        if (!receiverUrl) {
            return { ok: false, message: 'The TV pairing QR is missing a receiver URL.' };
        }
        try {
            var receiver = new URL(receiverUrl);
            if (!/^https?:$/i.test(receiver.protocol)) {
                return { ok: false, message: 'The TV pairing receiver URL must use HTTP or HTTPS.' };
            }
        } catch (_) {
            return { ok: false, message: 'The TV pairing receiver URL is invalid.' };
        }
        if (!pairingToken) {
            return { ok: false, message: 'The TV pairing QR is missing a pairing token.' };
        }
        if (!isFinite(expiresAt) || expiresAt <= Date.now()) {
            return { ok: false, message: 'That TV pairing code has expired. Start pairing again on the TV.' };
        }

        return {
            ok: true,
            payload: {
                version: 1,
                receiver_url: receiverUrl,
                pairing_token: pairingToken,
                manual_code: normalizeManualCode(parsed.manual_code),
                device_name: String(parsed.device_name || '').trim(),
                expires_at_epoch_ms: expiresAt
            }
        };
    }

    function updateTvPairingSteps(activeStep) {
        state.step = activeStep;
        document.querySelectorAll('.tv-pairing-step').forEach(function(node) {
            node.classList.toggle('active', node.id === 'tv-pairing-step-' + activeStep);
        });
        if (activeStep !== 'scan') stopTvQrScanner();
    }

    function renderTvPairingConfirmation() {
        var card = el('tv-pairing-confirm-card');
        var target = state.mode === 'qr' ? state.pendingPayload : state.selectedCandidate;
        if (!card || !target) return;

        var pairingLabel = state.mode === 'qr'
            ? 'QR Pairing'
            : (state.sourceStep === 'direct' ? 'TV URL' : 'Manual Code');
        var detailLines = [];
        if (target.device_name) detailLines.push('Device: ' + target.device_name);
        if (target.ip) detailLines.push('IP: ' + target.ip);
        if (target.receiver_url) detailLines.push('Receiver: ' + target.receiver_url);
        detailLines.push('Expires: ' + formatExpiry(target.expires_at_epoch_ms));
        if (state.mode === 'manual' && !target.pairing_token) {
            detailLines.push('Note: this TV will use the 6-character code as the pairing credential.');
        }

        card.innerHTML =
            '<div class="tv-pairing-badge">' + escapeHtml(pairingLabel) + '</div>' +
            '<h3 style="margin:14px 0 10px 0;">' + escapeHtml(target.device_name || 'TV') + '</h3>' +
            '<div class="tv-pairing-confirm-meta">' + escapeHtml(detailLines.join(' • ')) + '</div>' +
            '<p class="tv-pairing-help" style="margin-bottom:0;">Send the current SpatialFin Companion configuration to this TV?</p>';
    }

    function resetTvPairingResults() {
        var results = el('tv-pairing-manual-results');
        if (results) results.innerHTML = '';
        state.manualCandidates = [];
        state.selectedCandidate = null;
    }

    async function startTvQrScanner() {
        clearTvPairingError();
        if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
            setTvPairingError('Camera access requires HTTPS or localhost. Use Enter TV Code or Use TV URL instead.');
            return;
        }
        if (!('BarcodeDetector' in window) || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            setTvPairingError('QR scanning is not supported in this browser. Use Enter TV Code or Use TV URL instead.');
            return;
        }

        var video = el('tv-pairing-video');
        var placeholder = el('tv-pairing-camera-placeholder');
        if (!video || !placeholder) return;

        stopTvQrScanner();
        try {
            if (window.BarcodeDetector.getSupportedFormats) {
                var formats = await window.BarcodeDetector.getSupportedFormats();
                if (Array.isArray(formats) && formats.indexOf('qr_code') === -1) {
                    setTvPairingError('This browser does not expose QR detection. Use Enter TV Code or Use TV URL instead.');
                    return;
                }
            }
            state.detector = new window.BarcodeDetector({ formats: ['qr_code'] });
            state.stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: { ideal: 'environment' }
                },
                audio: false
            });
            video.srcObject = state.stream;
            await video.play();
            video.classList.add('active');
            placeholder.style.display = 'none';
            scanTvQrFrame();
        } catch (error) {
            setTvPairingError('Camera access failed: ' + (error.message || 'unknown error'));
        }
    }

    function stopTvQrScanner() {
        if (state.scanTimer) {
            clearTimeout(state.scanTimer);
            state.scanTimer = null;
        }
        if (state.stream) {
            state.stream.getTracks().forEach(function(track) {
                track.stop();
            });
            state.stream = null;
        }
        var video = el('tv-pairing-video');
        var placeholder = el('tv-pairing-camera-placeholder');
        if (video) {
            video.pause();
            video.srcObject = null;
            video.classList.remove('active');
        }
        if (placeholder) placeholder.style.display = 'flex';
    }

    async function scanTvQrFrame() {
        if (state.step !== 'scan' || !state.detector || !state.stream) return;
        var video = el('tv-pairing-video');
        if (!video || video.readyState < 2) {
            state.scanTimer = setTimeout(scanTvQrFrame, 250);
            return;
        }

        try {
            var codes = await state.detector.detect(video);
            if (codes && codes.length > 0) {
                var rawValue = codes[0].rawValue || codes[0].displayValue || '';
                var parsed = parseTvPairingQrText(rawValue);
                if (parsed.ok) {
                    state.mode = 'qr';
                    state.sourceStep = 'scan';
                    state.pendingPayload = parsed.payload;
                    stopTvQrScanner();
                    renderTvPairingConfirmation();
                    updateTvPairingSteps('confirm');
                    setTvPairingSubtitle('Confirm the TV before sending the current companion config.');
                    return;
                }
                setTvPairingError(parsed.message);
            }
        } catch (error) {
            setTvPairingError('QR scan failed: ' + (error.message || 'unknown error'));
        }

        state.scanTimer = setTimeout(scanTvQrFrame, 350);
    }

    function renderManualCandidates(candidates, scannedCount) {
        var container = el('tv-pairing-manual-results');
        if (!container) return;
        if (!candidates || !candidates.length) {
            container.innerHTML = '<div class="tv-pairing-result-item"><div><strong>No matching TVs found.</strong><div class="tv-pairing-result-meta">Scanned ' + escapeHtml(String(scannedCount || 0)) + ' local addresses.</div></div></div>';
            return;
        }

        container.innerHTML = candidates.map(function(candidate, index) {
            var meta = [
                candidate.ip,
                'Expires ' + formatExpiry(candidate.expires_at_epoch_ms)
            ];
            return '<div class="tv-pairing-result-item">' +
                '<div>' +
                    '<div><strong>' + escapeHtml(candidate.device_name || 'TV') + '</strong></div>' +
                    '<div class="tv-pairing-result-meta">' + escapeHtml(meta.join(' • ')) + '</div>' +
                '</div>' +
                '<button onclick="selectManualTvCandidate(' + index + ')">Choose</button>' +
            '</div>';
        }).join('');
    }

    window.openTvPairingModal = function(initialStep) {
        clearTvPairingError();
        el('tv-pairing-modal').style.display = 'flex';
        resetTvPairingResults();
        state.pendingPayload = null;
        state.selectedCandidate = null;
        state.mode = null;
        state.sourceStep = 'home';
        showTvPairingStep(initialStep || 'home');
    };

    window.closeTvPairingModal = function() {
        stopTvQrScanner();
        clearTvPairingError();
        resetTvPairingResults();
        el('tv-pairing-modal').style.display = 'none';
        state.pendingPayload = null;
        state.selectedCandidate = null;
        state.mode = null;
        state.busy = false;
        state.sourceStep = 'home';
    };

    window.showTvPairingStep = function(step) {
        clearTvPairingError();
        if (step === 'home') {
            setTvPairingSubtitle('Choose how to connect this phone companion to your Google TV.');
            updateTvPairingSteps('home');
            return;
        }
        if (step === 'scan') {
            state.sourceStep = 'scan';
            setTvPairingSubtitle('Scan the QR code currently shown on the TV.');
            updateTvPairingSteps('scan');
            startTvQrScanner();
            return;
        }
        if (step === 'manual') {
            state.sourceStep = 'manual';
            setTvPairingSubtitle('Enter the TV code and search the local network for matching TVs.');
            updateTvPairingSteps('manual');
            return;
        }
        if (step === 'direct') {
            state.sourceStep = 'direct';
            setTvPairingSubtitle('Enter the TV receiver URL and the 6-character code shown on the TV.');
            updateTvPairingSteps('direct');
            return;
        }
        if (step === 'confirm') {
            updateTvPairingSteps('confirm');
            return;
        }
        if (step === 'status') {
            updateTvPairingSteps('status');
        }
    };

    window.restartTvQrScanner = function() {
        if (state.step !== 'scan') {
            showTvPairingStep('scan');
            return;
        }
        startTvQrScanner();
    };

    window.discoverTvByManualCode = async function() {
        clearTvPairingError();
        resetTvPairingResults();
        var input = el('tv-manual-code-input');
        var manualCode = normalizeManualCode(input && input.value);
        if (input) input.value = manualCode;
        if (manualCode.length !== 6) {
            setTvPairingError('Enter the full 6-character TV code.');
            return;
        }

        var results = el('tv-pairing-manual-results');
        if (results) {
            results.innerHTML = '<div class="tv-pairing-result-item"><div><strong>Searching local TVs...</strong><div class="tv-pairing-result-meta">Scanning likely local subnet addresses.</div></div></div>';
        }

        try {
            var res = await fetch('/api/admin/tv-pairing/discover', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ manualCode: manualCode })
            });
            var data = await res.json();
            if (!res.ok) {
                setTvPairingError(data.message || 'TV discovery failed.');
                if (results) results.innerHTML = '';
                return;
            }

            state.mode = 'manual';
            state.manualCandidates = Array.isArray(data.candidates) ? data.candidates : [];
            renderManualCandidates(state.manualCandidates, data.scannedCount);
            if (state.manualCandidates.length === 1) {
                state.selectedCandidate = state.manualCandidates[0];
                state.sourceStep = 'manual';
                renderTvPairingConfirmation();
                setTvPairingSubtitle('Confirm the TV before sending the current companion config.');
                updateTvPairingSteps('confirm');
            }
        } catch (error) {
            setTvPairingError('TV discovery failed: ' + (error.message || 'unknown error'));
            if (results) results.innerHTML = '';
        }
    };

    window.selectManualTvCandidate = function(index) {
        var candidate = state.manualCandidates[index];
        if (!candidate) return;
        state.mode = 'manual';
        state.sourceStep = 'manual';
        state.selectedCandidate = candidate;
        renderTvPairingConfirmation();
        setTvPairingSubtitle('Confirm the TV before sending the current companion config.');
        updateTvPairingSteps('confirm');
    };

    window.returnToTvPairingSource = function() {
        if (state.sourceStep === 'scan') {
            showTvPairingStep('scan');
            return;
        }
        if (state.sourceStep === 'direct') {
            showTvPairingStep('direct');
            return;
        }
        showTvPairingStep('manual');
    };

    window.resolveTvByReceiverUrl = async function() {
        clearTvPairingError();
        state.selectedCandidate = null;

        var receiverInput = el('tv-direct-receiver-input');
        var codeInput = el('tv-direct-code-input');
        var receiverUrl = receiverInput && receiverInput.value ? receiverInput.value.trim() : '';
        var manualCode = normalizeManualCode(codeInput && codeInput.value);
        if (codeInput) codeInput.value = manualCode;

        if (!receiverUrl) {
            setTvPairingError('Enter the TV receiver URL shown on the TV.');
            return;
        }
        if (manualCode.length !== 6) {
            setTvPairingError('Enter the full 6-character TV code.');
            return;
        }

        try {
            var res = await fetch('/api/admin/tv-pairing/resolve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    receiverUrl: receiverUrl,
                    manualCode: manualCode
                })
            });
            var data = await res.json();
            if (!res.ok) {
                setTvPairingError(data.message || 'TV lookup failed.');
                return;
            }

            state.mode = 'manual';
            state.sourceStep = 'direct';
            state.selectedCandidate = data.candidate || null;
            if (!state.selectedCandidate) {
                throw new Error('The TV lookup did not return a candidate.');
            }
            renderTvPairingConfirmation();
            setTvPairingSubtitle('Confirm the TV before sending the current companion config.');
            updateTvPairingSteps('confirm');
        } catch (error) {
            setTvPairingError('TV lookup failed: ' + (error.message || 'unknown error'));
        }
    };

    window.confirmTvPairing = async function() {
        if (state.busy) return;
        clearTvPairingError();
        state.busy = true;
        renderTvPairingStatus('pending', 'Sending config to TV', 'Pushing the current SpatialFin Companion settings over the local network.');
        updateTvPairingSteps('status');

        try {
            var endpoint;
            var body;
            if (state.mode === 'qr' && state.pendingPayload) {
                endpoint = '/api/admin/tv-pairing/pair-qr';
                body = {
                    payload: state.pendingPayload,
                    companionUrl: window.location.origin
                };
            } else if (state.mode === 'manual' && state.selectedCandidate) {
                endpoint = '/api/admin/tv-pairing/pair-manual';
                body = {
                    candidate: state.selectedCandidate,
                    companionUrl: window.location.origin
                };
            } else {
                throw new Error('No TV pairing target is selected.');
            }

            var res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            var data = await res.json();
            if (!res.ok) {
                throw new Error(data.message || 'TV pairing failed.');
            }

            renderTvPairingStatus('success', 'TV paired', (data.deviceName || 'TV') + ' is now linked to this companion.');
            if (typeof showToast === 'function') showToast('TV paired successfully', 'success');
        } catch (error) {
            renderTvPairingStatus('error', 'TV pairing failed', error.message || 'The TV pairing request failed.');
            setTvPairingError(error.message || 'The TV pairing request failed.');
            if (typeof showToast === 'function') showToast(error.message || 'TV pairing failed', 'error');
        } finally {
            state.busy = false;
        }
    };

    document.addEventListener('DOMContentLoaded', function() {
        var input = el('tv-manual-code-input');
        if (input) {
            input.addEventListener('input', function() {
                input.value = normalizeManualCode(input.value);
            });
            input.addEventListener('keydown', function(event) {
                if (event.key === 'Enter') discoverTvByManualCode();
            });
        }

        var directCodeInput = el('tv-direct-code-input');
        if (directCodeInput) {
            directCodeInput.addEventListener('input', function() {
                directCodeInput.value = normalizeManualCode(directCodeInput.value);
            });
            directCodeInput.addEventListener('keydown', function(event) {
                if (event.key === 'Enter') resolveTvByReceiverUrl();
            });
        }

        var directReceiverInput = el('tv-direct-receiver-input');
        if (directReceiverInput) {
            directReceiverInput.addEventListener('keydown', function(event) {
                if (event.key === 'Enter') resolveTvByReceiverUrl();
            });
        }

        var modal = el('tv-pairing-modal');
        if (modal) {
            modal.addEventListener('click', function(event) {
                if (event.target === modal) closeTvPairingModal();
            });
        }
    });
})();
