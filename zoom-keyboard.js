/* ======================================================
   FLOATING KEYBOARD TOGGLE + PAN/ZOOM — zoom-keyboard.js
   ======================================================
   OFF mode: 1-finger drag = pan, tap = place fake caret (no keyboard)
   ON mode : normal contenteditable behaviour (tap/drag/keyboard native)
   Pinch (2 fingers) = zoom, always active in both modes.
   ====================================================== */

(function () {
    "use strict";

    const viewport = document.getElementById("zoom-viewport");
    const panLayer = document.getElementById("pan-layer");
    const content = document.getElementById("pages-container");
    const toggleBtn = document.getElementById("keyboard-toggle-btn");
    if (!viewport || !panLayer || !content || !toggleBtn) return; // HTML not wired up yet

    /* ------------------------------------------------
       STATE
    ------------------------------------------------ */
    let scale = 1, panX = 0, panY = 0;
    let keyboardMode = false;

    let singleStartX = 0, singleStartY = 0;
    let dragStartPanX = 0, dragStartPanY = 0;
    let isDragging = false;
    const DRAG_THRESHOLD = 8; // px before a tap becomes a pan

    let pinchActive = false;
    let pinchStartDist = 0, pinchStartScale = 1;
    let pinchAnchorContentX = 0, pinchAnchorContentY = 0;

    let fakeCaretEl = null;

    const MIN_SCALE = 0.5, MAX_SCALE = 3;

    /* ------------------------------------------------
       TRANSFORM
       Pan uses transform:translate() on an outer layer (cheap,
       never blurry). Zoom uses the CSS `zoom` property on the
       inner content layer — unlike transform:scale(), `zoom`
       reflows and re-rasterizes text at native resolution instead
       of stretching a cached bitmap, so text/table borders stay
       sharp at any zoom level (this is why PDF export always
       looked sharp while the old transform-scale preview didn't).
    ------------------------------------------------ */
    function applyTransform() {
        panLayer.style.transform = "translate(" + panX + "px," + panY + "px)";
        content.style.zoom = scale;
    }

    function screenToContent(x, y) {
        const rect = viewport.getBoundingClientRect();
        return {
            x: (x - rect.left - panX) / scale,
            y: (y - rect.top - panY) / scale
        };
    }

    /* ------------------------------------------------
       FAKE CARET (visible cursor marker while keyboard is OFF)
       It's inserted as a real DOM node at the tapped position, so
       it automatically pans/zooms along with the content — no
       separate coordinate math needed to keep it in sync.
    ------------------------------------------------ */
    function clearFakeCaret() {
        if (fakeCaretEl && fakeCaretEl.parentNode) fakeCaretEl.remove();
        fakeCaretEl = null;
    }

    function placeFakeCaretAtPoint(clientX, clientY) {
        let range = null;
        if (document.caretRangeFromPoint) {
            range = document.caretRangeFromPoint(clientX, clientY);
        } else if (document.caretPositionFromPoint) {
            const pos = document.caretPositionFromPoint(clientX, clientY);
            if (pos) {
                range = document.createRange();
                range.setStart(pos.offsetNode, pos.offset);
            }
        }
        if (!range) return;

        const page = closestPageEl(range.startContainer);
        if (!page) return; // tapped outside any editable page

        clearFakeCaret();
        const marker = document.createElement("span");
        marker.className = "fake-caret";
        marker.contentEditable = "false";
        range.insertNode(marker);
        fakeCaretEl = marker;
    }

    function closestPageEl(node) {
        let n = node && node.nodeType === 3 ? node.parentElement : node;
        while (n && (!n.classList || !n.classList.contains("page"))) n = n.parentElement;
        return n;
    }

    /* ------------------------------------------------
       KEYBOARD TOGGLE
    ------------------------------------------------ */
    function focusWithoutNativeZoom(page) {
        // Mobile Chrome auto-zooms the viewport when a small-font
        // (<16px) editable region gains focus, regardless of our own
        // pinch-zoom system and regardless of the viewport meta tag
        // (recent Chrome versions ignore user-scalable=no for
        // accessibility reasons). Temporarily lifting the font size
        // above that threshold for the brief moment focus happens
        // suppresses the native zoom without changing how the page
        // actually looks — it's reverted right after.
        const prevFontSize = page.style.fontSize;
        page.style.fontSize = "16px";
        page.focus({ preventScroll: true });
        setTimeout(() => {
            page.style.fontSize = prevFontSize;
        }, 400);
    }

    function turnKeyboardOn() {
        let range = document.createRange();
        let page;

        if (fakeCaretEl && fakeCaretEl.isConnected) {
            page = closestPageEl(fakeCaretEl);
            range.setStartBefore(fakeCaretEl);
            range.collapse(true);
            clearFakeCaret();
        } else {
            // no prior tap — fall back to the end of the first page
            page = document.querySelector(".page");
            if (!page) return;
            range.selectNodeContents(page);
            range.collapse(false);
        }

        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);

        focusWithoutNativeZoom(page);

        keyboardMode = true;
        toggleBtn.classList.add("active");
        toggleBtn.textContent = "⌨️";
    }

    function turnKeyboardOff() {
        if (document.activeElement && document.activeElement.blur) {
            document.activeElement.blur();
        }
        keyboardMode = false;
        toggleBtn.classList.remove("active");
        toggleBtn.textContent = "🔒";
    }

    toggleBtn.addEventListener("click", () => {
        try {
            if (keyboardMode) turnKeyboardOff();
            else turnKeyboardOn();
        } catch (e) {
            // never let a stray error leave the button stuck — fall
            // back to a safe, known-good state instead of doing nothing
            clearFakeCaret();
            keyboardMode = false;
            toggleBtn.classList.remove("active");
            toggleBtn.textContent = "🔒";
        }
    });

    /* ------------------------------------------------
       TOUCH GESTURES
    ------------------------------------------------ */
    function dist(t1, t2) {
        const dx = t1.clientX - t2.clientX, dy = t1.clientY - t2.clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }
    function midpoint(t1, t2) {
        return { x: (t1.clientX + t2.clientX) / 2, y: (t1.clientY + t2.clientY) / 2 };
    }

    // Track recent pan movement so we can compute a release velocity
    // for momentum scrolling (WPS/native-scroll-style deceleration).
    let velX = 0, velY = 0;
    let lastMoveTime = 0, lastMoveX = 0, lastMoveY = 0;
    let momentumFrame = null;
    const STOP_VELOCITY_MIN = 0.05;

    function stopMomentum() {
        if (momentumFrame) {
            cancelAnimationFrame(momentumFrame);
            momentumFrame = null;
        }
    }

    function startMomentum() {
        const FRICTION = 0.94;
        const STOP_THRESHOLD = 0.03;
        function step() {
            velX *= FRICTION;
            velY *= FRICTION;
            if (Math.abs(velX) < STOP_THRESHOLD && Math.abs(velY) < STOP_THRESHOLD) {
                momentumFrame = null;
                return;
            }
            panX += velX;
            panY += velY;
            applyTransform();
            momentumFrame = requestAnimationFrame(step);
        }
        stopMomentum();
        momentumFrame = requestAnimationFrame(step);
    }

    // Re-baseline single-finger pan tracking from a given touch point,
    // without this a finger lifting out of a pinch (or any other
    // touch-count transition) causes a sudden jump on the next move.
    function rebaselineSingleDrag(touch) {
        singleStartX = touch.clientX;
        singleStartY = touch.clientY;
        dragStartPanX = panX;
        dragStartPanY = panY;
    }

    function resetGestureState() {
        pinchActive = false;
        isDragging = false;
    }

    // While the keyboard is ON, dragging directly on text should still
    // do native text-selection (needed for the font-size/bold tools) —
    // but dragging on genuinely empty space (below the last line, wide
    // margins, gaps between blocks) should still pan the page, since
    // there's nothing there to select anyway.
    function isEmptyAreaTouch(x, y) {
        const el = document.elementFromPoint(x, y);
        if (!el) return true;
        if (el.classList && el.classList.contains("page")) return true;
        if (el.classList && el.classList.contains("page-wrapper")) return true;
        if (el.id === "pages-container" || el.id === "pan-layer" || el.id === "zoom-viewport") return true;
        return false;
    }

    let allowCustomPan = true;

    viewport.addEventListener("touchstart", function (e) {
      try {
        stopMomentum();

        if (e.touches.length === 2) {
            pinchActive = true;
            isDragging = false;
            pinchStartDist = dist(e.touches[0], e.touches[1]);
            pinchStartScale = scale;
            const mid = midpoint(e.touches[0], e.touches[1]);
            const c = screenToContent(mid.x, mid.y);
            pinchAnchorContentX = c.x;
            pinchAnchorContentY = c.y;
            e.preventDefault();
            return;
        }

        if (e.touches.length === 1) {
            rebaselineSingleDrag(e.touches[0]);
            isDragging = false;
            lastMoveTime = performance.now();
            lastMoveX = e.touches[0].clientX;
            lastMoveY = e.touches[0].clientY;
            velX = 0; velY = 0;

            allowCustomPan = !keyboardMode || isEmptyAreaTouch(e.touches[0].clientX, e.touches[0].clientY);

            if (allowCustomPan) {
                // block native focus/keyboard trigger (OFF mode) or
                // native selection-start (ON mode, empty area) — we
                // handle tap/pan ourselves in both those cases
                e.preventDefault();
            }
            // otherwise (ON mode, touch is on real text): do nothing
            // custom, native contenteditable tap/selection takes over
        }
      } catch (err) {
        resetGestureState();
      }
    }, { passive: false });

    viewport.addEventListener("touchmove", function (e) {
      try {
        if (pinchActive && e.touches.length === 2) {
            const newDist = dist(e.touches[0], e.touches[1]);
            let newScale = pinchStartScale * (newDist / pinchStartDist);
            newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, newScale));
            const mid = midpoint(e.touches[0], e.touches[1]);
            const rect = viewport.getBoundingClientRect();
            panX = (mid.x - rect.left) - pinchAnchorContentX * newScale;
            panY = (mid.y - rect.top) - pinchAnchorContentY * newScale;
            scale = newScale;
            applyTransform();
            e.preventDefault();
            return;
        }

        if (allowCustomPan && e.touches.length === 1 && !pinchActive) {
            const dx = e.touches[0].clientX - singleStartX;
            const dy = e.touches[0].clientY - singleStartY;
            if (!isDragging && Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
                isDragging = true;
                clearFakeCaret(); // starting a pan cancels any pending tap-caret
            }
            if (isDragging) {
                panX = dragStartPanX + dx;
                panY = dragStartPanY + dy;
                applyTransform();

                // sample velocity (px/ms) over the last move for momentum on release
                const now = performance.now();
                const dt = now - lastMoveTime;
                if (dt > 0) {
                    velX = (e.touches[0].clientX - lastMoveX) / dt * 16; // normalize to ~one frame (16ms)
                    velY = (e.touches[0].clientY - lastMoveY) / dt * 16;
                }
                lastMoveTime = now;
                lastMoveX = e.touches[0].clientX;
                lastMoveY = e.touches[0].clientY;

                e.preventDefault();
            }
        }
        // not allowCustomPan → let native text-selection dragging run untouched
      } catch (err) {
        resetGestureState();
      }
    }, { passive: false });

    viewport.addEventListener("touchend", function (e) {
      try {
        if (pinchActive) {
            if (e.touches.length < 2) {
                pinchActive = false;
                if (e.touches.length === 1) {
                    // one finger still down after a pinch — restart pan
                    // tracking from here so the next move doesn't jump
                    rebaselineSingleDrag(e.touches[0]);
                    isDragging = false;
                    lastMoveTime = performance.now();
                    lastMoveX = e.touches[0].clientX;
                    lastMoveY = e.touches[0].clientY;
                    velX = 0; velY = 0;
                }
            }
            return;
        }

        if (!keyboardMode && !isDragging && e.changedTouches.length === 1) {
            const t = e.changedTouches[0];
            placeFakeCaretAtPoint(t.clientX, t.clientY);
        }

        if (isDragging && (Math.abs(velX) > STOP_VELOCITY_MIN || Math.abs(velY) > STOP_VELOCITY_MIN)) {
            startMomentum();
        }
        isDragging = false;
      } catch (err) {
        resetGestureState();
      }
    }, { passive: true });

    /* ------------------------------------------------
       KEEP PAGE POSITION STABLE WHEN KEYBOARD OPENS
       We resize (not scroll) the viewport to the visible area, so
       the browser never has a reason to scroll the page underneath
       the keyboard — panX/panY are left untouched.
    ------------------------------------------------ */
    function syncViewportToVisualViewport() {
        if (!window.visualViewport) return;
        const top = viewport.getBoundingClientRect().top;
        const available = window.visualViewport.height - top;
        viewport.style.height = Math.max(available, 100) + "px";
    }
    if (window.visualViewport) {
        window.visualViewport.addEventListener("resize", syncViewportToVisualViewport);
        window.visualViewport.addEventListener("scroll", syncViewportToVisualViewport);
    }

    applyTransform();
})();