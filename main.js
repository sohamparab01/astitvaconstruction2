/**
 * ASTITVA CONSTRUCTION — Main Client Script
 * Ultra-Smooth High-Performance Cinematic Frame Scroll Animation & Homepage Interactions
 * 
 * - Full Bidirectional Scrubbing: forward and reverse animations are completely smooth and continuous.
 * - Persistent In-Memory Cache: every loaded frame is retained so reversing through visited frames is instant.
 * - Direction-Aware Background Loader: shifts preloading priority backwards when scrolling up, and forwards when scrolling down.
 * - Generous Lookahead & Lookbehind: preloads 45 frames ahead and 25 frames behind the active cursor.
 * - Zero in-flight cancellations, zero canvas flickering, zero screen movement.
 * - Integrated seamlessly with full responsive multi-section homepage.
 */

(function () {
  'use strict';

  // --- Configuration ---
  // --- Configuration ---
  const TOTAL_FRAMES = 359; // Master unique frames (12-second 30fps master source)
  const FRAME_WIDTH = 1920;
  const FRAME_HEIGHT = 1080;

  // Calibrated for silky smooth, responsive frame progression
  const MAX_VIRTUAL_SCROLL = 5000;
  const LERP_FACTOR = 0.35; // Instantaneous, crisp response with gentle ~120ms settle
  const STOP_THRESHOLD = 3.0; // Clean snap within 0.2 frame to prevent slow tail drag
  const FRAME_STEP = MAX_VIRTUAL_SCROLL / (TOTAL_FRAMES - 1); // ~13.96 units per unique frame

  const MAX_CONCURRENT_REQUESTS = 6; // Optimal non-blocking HTTP pipeline throughput
  const PRIORITY_AHEAD = 35; // 35 unique frames ahead in active scrub direction
  const PRIORITY_BEHIND = 10; // 10 unique frames behind cursor

  // Ensure clean initial load at top without scroll restoration flashing solid header
  if ('scrollRestoration' in history) {
    history.scrollRestoration = 'manual';
  }

  // --- DOM Elements ---
  const canvas = document.getElementById('cinematic-canvas');
  if (!canvas) {
    console.error('Canvas element not found.');
    return;
  }

  const ctx = canvas.getContext('2d', { alpha: false });
  const scrollContainer = document.getElementById('cinematic-scroll-container');
  const siteHeader = document.getElementById('site-header');
  const scrollIndicator = document.getElementById('hero-scroll-indicator');
  const heroLogoBadge = document.getElementById('hero-logo-badge');

  // --- Animation State Variables ---
  let targetVirtualScroll = 0;
  let currentVirtualScroll = 0;

  let currentFrameIndex = 1;
  let lastDrawnFrameIndex = -1;
  let lastDrawnImage = null;
  let scrollDirection = 1; // 1 = forward/down, -1 = reverse/up

  // Image Cache & Queues (Persistent cache - never evicts so reversing is instantaneous)
  const loadedImages = new Map(); // frameIndex -> HTMLImageElement
  const requestedFrames = new Set(); // frameIndices currently loading or queued
  let priorityQueue = []; // High-priority frames near active scroll
  let activeRequests = 0;
  let isRenderPending = false;

  // Base URL resolver ensuring proper asset paths on both local dev and GitHub Pages subdirectories
  const BASE_URL = (import.meta.env && import.meta.env.BASE_URL) ? import.meta.env.BASE_URL : '/';
  const NORMALIZED_BASE = BASE_URL.endsWith('/') ? BASE_URL : `${BASE_URL}/`;

  function resolveAssetUrl(assetPath) {
    if (!assetPath) return '';
    const cleanPath = assetPath.startsWith('/') ? assetPath.slice(1) : assetPath;
    return `${NORMALIZED_BASE}${cleanPath}`;
  }

  // --- Utility Functions ---
  function getFrameUrl(index) {
    // Maps each logical unique frame (1..359) to its master PNG in /frames/
    // Since the 1436 files contain 4 duplicate copies of every frame (1-4, 5-8, 9-12...),
    // this directly accesses each genuine unique frame (1, 5, 9, 13, ..., 1433), eliminating
    // 75% of network bandwidth and preventing 4-frame static stutter during scrubbing.
    const fileIndex = (index - 1) * 4 + 1;
    const padded = String(fileIndex).padStart(4, '0');
    return resolveAssetUrl(`frames/frame_${padded}.png`);
  }

  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  // --- Canvas Sizing & Cover-Fit Rendering ---
  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const displayWidth = window.innerWidth;
    const displayHeight = window.innerHeight;

    const targetWidth = Math.round(displayWidth * dpr);
    const targetHeight = Math.round(displayHeight * dpr);

    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }

    if (lastDrawnImage) {
      drawCoverImage(lastDrawnImage);
    }
  }

  function drawCoverImage(img) {
    if (!img || !img.complete || img.naturalWidth === 0) return;

    const cw = canvas.width;
    const ch = canvas.height;
    const iw = img.naturalWidth || FRAME_WIDTH;
    const ih = img.naturalHeight || FRAME_HEIGHT;

    const scale = Math.max(cw / iw, ch / ih);
    const drawW = iw * scale;
    const drawH = ih * scale;
    const drawX = (cw - drawW) * 0.5;
    const drawY = (ch - drawH) * 0.5;

    ctx.drawImage(img, drawX, drawY, drawW, drawH);
  }

  // --- Direction-Aware High-Throughput Preloader Engine ---
  function updatePriorityPreload(targetFrame) {
    const desired = [];

    // 1. Target frame is absolute first priority
    if (!loadedImages.has(targetFrame) && !requestedFrames.has(targetFrame)) {
      desired.push(targetFrame);
    }

    // 2. High priority lookahead in current scrub direction (forward or backward)
    for (let i = 1; i <= PRIORITY_AHEAD; i++) {
      const idx = targetFrame + i * scrollDirection;
      if (idx >= 1 && idx <= TOTAL_FRAMES && !loadedImages.has(idx) && !requestedFrames.has(idx)) {
        desired.push(idx);
      }
    }

    // 3. Compact lookbehind frames for seamless direction reversals
    for (let i = 1; i <= PRIORITY_BEHIND; i++) {
      const idx = targetFrame - i * scrollDirection;
      if (idx >= 1 && idx <= TOTAL_FRAMES && !loadedImages.has(idx) && !requestedFrames.has(idx)) {
        desired.push(idx);
      }
    }

    priorityQueue = desired;
    pumpLoader();
  }

  function pumpLoader() {
    while (activeRequests < MAX_CONCURRENT_REQUESTS) {
      let nextFrame = null;

      // First check priority queue (closest frames in current direction)
      while (priorityQueue.length > 0) {
        const candidate = priorityQueue.shift();
        if (!requestedFrames.has(candidate) && !loadedImages.has(candidate)) {
          nextFrame = candidate;
          break;
        }
      }

      // If priority queue is clear, use bidirectional background preloader
      if (nextFrame === null) {
        if (scrollDirection === -1) {
          // Scrolling UP: background loader prioritizes frames backwards towards frame 1
          for (let idx = currentFrameIndex; idx >= 1; idx--) {
            if (!requestedFrames.has(idx) && !loadedImages.has(idx)) {
              nextFrame = idx;
              break;
            }
          }
        } else {
          // Scrolling DOWN: background loader prioritizes frames forwards towards TOTAL_FRAMES
          for (let idx = currentFrameIndex; idx <= TOTAL_FRAMES; idx++) {
            if (!requestedFrames.has(idx) && !loadedImages.has(idx)) {
              nextFrame = idx;
              break;
            }
          }
        }

        // Global sweep if the active direction is fully loaded
        if (nextFrame === null) {
          for (let idx = 1; idx <= TOTAL_FRAMES; idx++) {
            if (!requestedFrames.has(idx) && !loadedImages.has(idx)) {
              nextFrame = idx;
              break;
            }
          }
        }
      }

      if (nextFrame === null) {
        // All 1436 frames loaded!
        break;
      }

      fetchFrame(nextFrame);
    }
  }

  function fetchFrame(frameIndex) {
    if (requestedFrames.has(frameIndex) || loadedImages.has(frameIndex)) return;
    requestedFrames.add(frameIndex);
    activeRequests++;

    const img = new Image();
    img.decoding = 'async';

    const onComplete = () => {
      activeRequests = Math.max(0, activeRequests - 1);
      loadedImages.set(frameIndex, img);

      // Render immediately if this newly loaded frame is closer to active position
      // than what's currently displayed on screen (eliminates frozen wait during glide)
      const isBetter = (scrollDirection >= 0 && frameIndex > lastDrawnFrameIndex && frameIndex <= currentFrameIndex) ||
                       (scrollDirection < 0 && frameIndex < lastDrawnFrameIndex && frameIndex >= currentFrameIndex) ||
                       frameIndex === currentFrameIndex;

      if (isBetter || (frameIndex === 1 && lastDrawnFrameIndex === -1)) {
        requestRender();
      }

      pumpLoader();
    };

    img.onload = onComplete;

    img.onerror = () => {
      activeRequests = Math.max(0, activeRequests - 1);
      pumpLoader();
    };

    img.src = getFrameUrl(frameIndex);
  }

  // --- Direction-Aware Frame Selection Strategy (Zero Flicker, Zero Forward Jumps) ---
  function getBestAvailableFrame(targetIndex) {
    if (loadedImages.has(targetIndex)) {
      return { index: targetIndex, img: loadedImages.get(targetIndex) };
    }

    // Directional lookup:
    // When moving forward (or stopping after forward scroll), search backward from targetIndex.
    // This guarantees we only show frames the user has already reached, avoiding the ugly
    // glitch where the canvas flashes forward to a future frame and then jumps back.
    if (scrollDirection >= 0) {
      for (let idx = targetIndex - 1; idx >= 1; idx--) {
        if (loadedImages.has(idx)) {
          return { index: idx, img: loadedImages.get(idx) };
        }
      }
      for (let idx = targetIndex + 1; idx <= TOTAL_FRAMES; idx++) {
        if (loadedImages.has(idx)) {
          return { index: idx, img: loadedImages.get(idx) };
        }
      }
    } else {
      // Scrolling in reverse: search forward towards where user just came from
      for (let idx = targetIndex + 1; idx <= TOTAL_FRAMES; idx++) {
        if (loadedImages.has(idx)) {
          return { index: idx, img: loadedImages.get(idx) };
        }
      }
      for (let idx = targetIndex - 1; idx >= 1; idx--) {
        if (loadedImages.has(idx)) {
          return { index: idx, img: loadedImages.get(idx) };
        }
      }
    }

    if (lastDrawnImage && lastDrawnFrameIndex !== -1) {
      return { index: lastDrawnFrameIndex, img: lastDrawnImage };
    }

    return null;
  }

  // --- Input Handlers (Smooth Forward & Reverse Scrubbing + Page Scroll Transition) ---
  function onWheel(e) {
    const isAtTop = window.scrollY <= 2;

    if (isAtTop) {
      if (e.deltaY > 0) {
        // Scrolling DOWN while at the top:
        // If animation is not yet 100% completed, intercept wheel and advance frames
        if (targetVirtualScroll < MAX_VIRTUAL_SCROLL || currentVirtualScroll < MAX_VIRTUAL_SCROLL - 15) {
          e.preventDefault();
          // Normalize scroll delta to prevent huge single-notch spikes while keeping natural trackpad response
          const normalizedDelta = Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 160);
          targetVirtualScroll = clamp(
            targetVirtualScroll + normalizedDelta,
            0,
            MAX_VIRTUAL_SCROLL
          );
          requestRender();
          updateUIState();
          return;
        }
        // Once targetVirtualScroll >= MAX_VIRTUAL_SCROLL (all frames completed!):
        // Allow the browser to naturally scroll down into the rest of the homepage!
      } else if (e.deltaY < 0) {
        // Scrolling UP while at the top:
        // If frames have progressed (targetVirtualScroll > 0), scrub them back in reverse!
        if (targetVirtualScroll > 0) {
          e.preventDefault();
          const normalizedDelta = Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 160);
          targetVirtualScroll = clamp(
            targetVirtualScroll + normalizedDelta,
            0,
            MAX_VIRTUAL_SCROLL
          );
          requestRender();
          updateUIState();
          return;
        }
      }
    }
  }

  let touchStartY = 0;
  let touchStartVirtualScroll = 0;

  function onTouchStart(e) {
    if (e.touches.length === 1) {
      touchStartY = e.touches[0].clientY;
      touchStartVirtualScroll = targetVirtualScroll;
    }
  }

  function onTouchMove(e) {
    if (e.touches.length === 1) {
      const isAtTop = window.scrollY <= 2;
      const deltaY = (touchStartY - e.touches[0].clientY) * 1.8;

      if (isAtTop) {
        if (deltaY > 0) {
          // Swiping up (trying to scroll down)
          if (targetVirtualScroll < MAX_VIRTUAL_SCROLL || currentVirtualScroll < MAX_VIRTUAL_SCROLL - 15) {
            if (e.cancelable) e.preventDefault();
            targetVirtualScroll = clamp(
              touchStartVirtualScroll + deltaY,
              0,
              MAX_VIRTUAL_SCROLL
            );
            requestRender();
            updateUIState();
            return;
          }
        } else if (deltaY < 0) {
          // Swiping down (trying to scroll up / reverse)
          if (targetVirtualScroll > 0) {
            if (e.cancelable) e.preventDefault();
            targetVirtualScroll = clamp(
              touchStartVirtualScroll + deltaY,
              0,
              MAX_VIRTUAL_SCROLL
            );
            requestRender();
            updateUIState();
            return;
          }
        }
      }
    }
  }

  function onKeyDown(e) {
    const isAtTop = window.scrollY <= 2;
    if (!isAtTop) return;

    if (e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === ' ') {
      if (targetVirtualScroll < MAX_VIRTUAL_SCROLL || currentVirtualScroll < MAX_VIRTUAL_SCROLL - 15) {
        e.preventDefault();
        targetVirtualScroll = clamp(targetVirtualScroll + 160, 0, MAX_VIRTUAL_SCROLL);
        requestRender();
        updateUIState();
      }
    } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
      if (targetVirtualScroll > 0) {
        e.preventDefault();
        targetVirtualScroll = clamp(targetVirtualScroll - 160, 0, MAX_VIRTUAL_SCROLL);
        requestRender();
        updateUIState();
      }
    }
  }

  function onWindowScroll() {
    updateUIState();

    if (window.scrollY > 40) {
      // Scrolled down into the homepage content
      if (scrollIndicator) scrollIndicator.style.opacity = '0';
      // Ensure frames stay at the completed transformation when viewing content below
      if (targetVirtualScroll < MAX_VIRTUAL_SCROLL) {
        targetVirtualScroll = MAX_VIRTUAL_SCROLL;
        currentVirtualScroll = MAX_VIRTUAL_SCROLL;
        currentFrameIndex = TOTAL_FRAMES;
        requestRender();
      }
    }
  }

  function updateUIState() {
    // Determine the real physical boundary of the cinematic hero container
    const heroHeight = scrollContainer ? scrollContainer.offsetHeight : window.innerHeight;
    // Solid ivory header ONLY when user has scrolled beyond the cinematic animation section into content below
    const isBeyondHero = window.scrollY >= (heroHeight - 80);

    if (siteHeader) {
      siteHeader.classList.toggle('header-scrolled', isBeyondHero);
    }
    if (scrollIndicator) {
      scrollIndicator.style.opacity = (targetVirtualScroll < 200 && window.scrollY <= 2) ? '1' : '0';
    }
  }

  // --- Animation & Render Loop ---
  function requestRender() {
    if (!isRenderPending) {
      isRenderPending = true;
      requestAnimationFrame(renderLoop);
    }
  }

  function renderLoop() {
    isRenderPending = false;

    // Direct, responsive momentum with smooth settle (zero lagging glide)
    const delta = targetVirtualScroll - currentVirtualScroll;
    const absDelta = Math.abs(delta);

    if (absDelta < STOP_THRESHOLD) {
      currentVirtualScroll = targetVirtualScroll;
    } else {
      currentVirtualScroll += delta * LERP_FACTOR;
    }

    // Map virtual scroll progress to frame indices
    const progress = currentVirtualScroll / MAX_VIRTUAL_SCROLL;
    const newFrameIndex = clamp(
      1 + Math.round(progress * (TOTAL_FRAMES - 1)),
      1,
      TOTAL_FRAMES
    );

    // Track scroll direction and update directional preloading
    if (newFrameIndex !== currentFrameIndex) {
      scrollDirection = newFrameIndex >= currentFrameIndex ? 1 : -1;
      currentFrameIndex = newFrameIndex;
      updatePriorityPreload(currentFrameIndex);
    }

    // Render best available frame
    const bestFrame = getBestAvailableFrame(currentFrameIndex);
    if (bestFrame && bestFrame.img) {
      if (bestFrame.index !== lastDrawnFrameIndex || !lastDrawnImage) {
        drawCoverImage(bestFrame.img);
        lastDrawnImage = bestFrame.img;
        lastDrawnFrameIndex = bestFrame.index;
      }
    }

    if (currentVirtualScroll !== targetVirtualScroll) {
      requestRender();
    }
  }

  // ==========================================================================
  // NAVIGATION & UI INTERACTION SYSTEM
  // ==========================================================================

  function initNavigation() {
    // 1. More Dropdown Toggle
    const moreBtn = document.getElementById('more-dropdown-btn');
    const moreMenu = document.getElementById('more-dropdown-menu');

    if (moreBtn && moreMenu) {
      function toggleDropdown(open) {
        const isOpen = open !== undefined ? open : !moreMenu.classList.contains('dropdown-open');
        moreMenu.classList.toggle('dropdown-open', isOpen);
        moreBtn.setAttribute('aria-expanded', String(isOpen));
      }

      moreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleDropdown();
      });

      // Close when clicking an item
      moreMenu.querySelectorAll('.dropdown-link').forEach((link) => {
        link.addEventListener('click', () => {
          toggleDropdown(false);
        });
      });

      // Close when clicking outside
      document.addEventListener('click', (e) => {
        if (!moreBtn.contains(e.target) && !moreMenu.contains(e.target)) {
          toggleDropdown(false);
        }
      });

      // Close on Escape key
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && moreMenu.classList.contains('dropdown-open')) {
          toggleDropdown(false);
          moreBtn.focus();
        }
      });
    }

    // 2. Mobile Menu Drawer Toggle
    const mobileToggle = document.getElementById('mobile-menu-toggle');
    const mobileClose = document.getElementById('mobile-menu-close');
    const mobileDrawer = document.getElementById('mobile-nav-drawer');
    const mobileBackdrop = document.getElementById('mobile-nav-backdrop');

    function toggleMobileDrawer(open) {
      if (!mobileDrawer || !mobileBackdrop) return;
      const isOpen = open !== undefined ? open : !mobileDrawer.classList.contains('drawer-open');
      mobileDrawer.classList.toggle('drawer-open', isOpen);
      mobileBackdrop.classList.toggle('drawer-open', isOpen);
      mobileDrawer.setAttribute('aria-hidden', String(!isOpen));
      if (mobileToggle) {
        mobileToggle.setAttribute('aria-expanded', String(isOpen));
      }
      document.body.style.overflow = isOpen ? 'hidden' : '';
    }

    if (mobileToggle) {
      mobileToggle.addEventListener('click', () => toggleMobileDrawer(true));
    }
    if (mobileClose) {
      mobileClose.addEventListener('click', () => toggleMobileDrawer(false));
    }
    if (mobileBackdrop) {
      mobileBackdrop.addEventListener('click', () => toggleMobileDrawer(false));
    }

    // Close mobile drawer on link click
    if (mobileDrawer) {
      mobileDrawer.querySelectorAll('.mobile-nav-link, .mobile-drawer-btn').forEach((link) => {
        link.addEventListener('click', () => {
          toggleMobileDrawer(false);
        });
      });

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && mobileDrawer.classList.contains('drawer-open')) {
          toggleMobileDrawer(false);
          if (mobileToggle) mobileToggle.focus();
        }
      });
    }

    // 3. Dynamic Active Navigation Highlighting
    const sections = document.querySelectorAll('section[id], footer[id]');
    const navLinks = document.querySelectorAll('.desktop-nav .nav-link:not(.nav-dropdown-btn)');

    if ('IntersectionObserver' in window && sections.length > 0) {
      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              const currentId = entry.target.getAttribute('id');
              navLinks.forEach((link) => {
                const href = link.getAttribute('href');
                if (href === `#${currentId}`) {
                  link.classList.add('active');
                } else if (href && !href.startsWith('#more')) {
                  link.classList.remove('active');
                }
              });
            }
          });
        },
        { rootMargin: '-20% 0px -70% 0px' }
      );

      sections.forEach((s) => observer.observe(s));
    }

    // 4. Smooth Anchor Link Scrolling
    document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
      anchor.addEventListener('click', function (e) {
        const targetId = this.getAttribute('href');
        if (targetId === '#' || targetId === '#more') return;

        const targetEl = document.querySelector(targetId);
        if (targetEl) {
          e.preventDefault();
          if (targetId !== '#cinematic-scroll-container') {
            targetVirtualScroll = MAX_VIRTUAL_SCROLL;
            currentVirtualScroll = MAX_VIRTUAL_SCROLL;
            currentFrameIndex = TOTAL_FRAMES;
            requestRender();

            const headerOffset = siteHeader ? siteHeader.offsetHeight : 80;
            const elementPosition = targetEl.getBoundingClientRect().top + window.scrollY;
            const offsetPosition = Math.max(0, elementPosition - headerOffset);

            window.scrollTo({
              top: offsetPosition,
              behavior: 'smooth'
            });
          } else {
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }
          if (history.pushState) {
            history.pushState(null, null, targetId);
          }
        }
      });
    });
  }

  // ==========================================================================
  // CONSULTATION MODAL & ENQUIRY FORM SYSTEM
  // ==========================================================================

  function initEnquirySystem() {
    const modalBackdrop = document.getElementById('enquiry-modal');
    const modalCloseBtn = document.getElementById('modal-close-btn');
    const modalBadgeIcon = document.getElementById('modal-badge-icon');
    const modalTitle = document.getElementById('modal-title');
    const modalSubtitle = document.getElementById('modal-subtitle');
    const modalBody = document.getElementById('modal-body');

    const whatsappBtn = document.getElementById('open-whatsapp-modal-btn');
    const phoneBtn = document.getElementById('open-phone-modal-btn');
    const enquiryForm = document.getElementById('project-enquiry-form');

    function openModal(title, subtitle, iconHtml, contentHtml) {
      if (!modalBackdrop) return;
      if (modalTitle) modalTitle.textContent = title;
      if (modalSubtitle) modalSubtitle.textContent = subtitle;
      if (modalBadgeIcon) modalBadgeIcon.innerHTML = iconHtml;
      if (modalBody) modalBody.innerHTML = contentHtml;

      modalBackdrop.classList.add('modal-open');
      modalBackdrop.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';

      const firstBtn = modalBody ? modalBody.querySelector('a, button') : null;
      if (firstBtn) firstBtn.focus();
    }

    function closeModal() {
      if (!modalBackdrop) return;
      modalBackdrop.classList.remove('modal-open');
      modalBackdrop.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = '';
    }

    if (modalCloseBtn) {
      modalCloseBtn.addEventListener('click', closeModal);
    }
    if (modalBackdrop) {
      modalBackdrop.addEventListener('click', (e) => {
        if (e.target === modalBackdrop) closeModal();
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modalBackdrop && modalBackdrop.classList.contains('modal-open')) {
        closeModal();
      }
    });

    const contactPhoneNumber = "+91 8097800430";
    const contactWaNumber = "918097800430";

    // WhatsApp Action Trigger
    if (whatsappBtn) {
      whatsappBtn.addEventListener('click', () => {
        const defaultMsg = encodeURIComponent(
          "Hello Astitva Construction, I would like to enquire about building restoration and civil repair services for our property."
        );
        const icon = `
          <div style="background-color: rgba(37, 211, 102, 0.15); color: #25D366; width: 56px; height: 56px; border-radius: 50%; display: flex; align-items: center; justify-content: center;">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.888 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
            </svg>
          </div>
        `;
        const content = `
          <div class="modal-message-box">
            <p><strong>Direct WhatsApp Connect:</strong></p>
            <p>Click the button below to open WhatsApp with a prefilled enquiry message ready to send to our engineering team.</p>
          </div>
          <div style="display: flex; flex-direction: column; gap: 0.75rem;">
            <a href="https://wa.me/${contactWaNumber}?text=${defaultMsg}" target="_blank" rel="noopener noreferrer" class="btn btn-whatsapp modal-action-btn">
              Open WhatsApp Chat
            </a>
            <a href="tel:+918097800430" class="btn btn-phone modal-action-btn">
              Direct Phone Call
            </a>
          </div>
        `;
        openModal('WhatsApp Consultation', 'Connect directly with Astitva Construction', icon, content);
      });
    }

    // Phone Action Trigger
    if (phoneBtn) {
      phoneBtn.addEventListener('click', () => {
        const defaultMsg = encodeURIComponent(
          "Hello Astitva Construction, I would like to request a technical consultation for our property."
        );
        const icon = `
          <div style="background-color: rgba(40, 39, 36, 0.1); color: var(--color-charcoal); width: 56px; height: 56px; border-radius: 50%; display: flex; align-items: center; justify-content: center;">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
            </svg>
          </div>
        `;
        const content = `
          <div class="modal-message-box">
            <p><strong>Telephone & Technical Consultation Line:</strong></p>
            <p>Speak directly with our restoration engineering team, or connect on WhatsApp to coordinate an on-site building inspection.</p>
          </div>
          <div style="display: flex; flex-direction: column; gap: 0.75rem;">
            <a href="tel:+918097800430" class="btn btn-primary modal-action-btn">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
              Call Us Directly
            </a>
            <a href="https://wa.me/${contactWaNumber}?text=${defaultMsg}" target="_blank" rel="noopener noreferrer" class="btn btn-whatsapp modal-action-btn">
              WhatsApp Consultation
            </a>
          </div>
        `;
        openModal('Technical Consultation', 'Direct communication with our engineering team', icon, content);
      });
    }

    // Enquiry Card Quick WhatsApp Submit
    const enquiryWaQuickBtn = document.getElementById('enquiry-card-whatsapp-submit-btn');
    if (enquiryWaQuickBtn) {
      enquiryWaQuickBtn.addEventListener('click', () => {
        const nameInput = document.getElementById('client-name');
        const contactInput = document.getElementById('client-contact');
        const propertyInput = document.getElementById('property-type');
        const serviceInput = document.getElementById('primary-service');
        const detailsInput = document.getElementById('project-details');

        const name = nameInput && nameInput.value.trim() ? nameInput.value.trim() : 'Prospective Client';
        const contact = contactInput && contactInput.value.trim() ? contactInput.value.trim() : 'Direct on WhatsApp';
        const property = propertyInput && propertyInput.value ? propertyInput.value : 'General Property';
        const service = serviceInput && serviceInput.value ? serviceInput.value : 'Building Restoration / Repair';
        const details = detailsInput && detailsInput.value.trim() ? detailsInput.value.trim() : 'Requesting initial discussion and site inspection';

        const summaryText = `*Project Enquiry — Astitva Construction*\n\n*Name:* ${name}\n*Contact:* ${contact}\n*Property Type:* ${property}\n*Service:* ${service}\n*Details:* ${details}`;
        const encodedSummary = encodeURIComponent(summaryText);
        window.open(`https://wa.me/${contactWaNumber}?text=${encodedSummary}`, '_blank', 'noopener,noreferrer');
      });
    }

    // Project Enquiry Form Submission
    if (enquiryForm) {
      enquiryForm.addEventListener('submit', (e) => {
        e.preventDefault();

        const nameInput = document.getElementById('client-name');
        const contactInput = document.getElementById('client-contact');
        const propertyInput = document.getElementById('property-type');
        const serviceInput = document.getElementById('primary-service');
        const detailsInput = document.getElementById('project-details');

        let isValid = true;

        if (!nameInput || !nameInput.value.trim()) {
          if (nameInput) nameInput.parentElement.classList.add('has-error');
          isValid = false;
        } else {
          nameInput.parentElement.classList.remove('has-error');
        }

        if (!contactInput || !contactInput.value.trim()) {
          if (contactInput) contactInput.parentElement.classList.add('has-error');
          isValid = false;
        } else {
          contactInput.parentElement.classList.remove('has-error');
        }

        if (!isValid) return;

        const name = nameInput.value.trim();
        const contact = contactInput.value.trim();
        const property = propertyInput ? propertyInput.value : 'Not specified';
        const service = serviceInput ? serviceInput.value : 'General Restoration';
        const details = detailsInput ? detailsInput.value.trim() : 'No additional details provided';

        const summaryText = `*Project Enquiry — Astitva Construction*\n\n*Name:* ${name}\n*Contact:* ${contact}\n*Property Type:* ${property}\n*Service:* ${service}\n*Details:* ${details}`;
        const encodedSummary = encodeURIComponent(summaryText);
        const waLink = `https://wa.me/${contactWaNumber}?text=${encodedSummary}`;

        const icon = `
          <div style="background-color: rgba(169, 54, 43, 0.15); color: var(--color-red); width: 56px; height: 56px; border-radius: 50%; display: flex; align-items: center; justify-content: center;">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
              <polyline points="22 4 12 14.01 9 11.01"/>
            </svg>
          </div>
        `;

        const content = `
          <div class="modal-message-box">
            <p><strong>Thank you, ${name}!</strong> Your enquiry details have been assembled. You can send this enquiry directly to our team via WhatsApp to initiate your preliminary discussion.</p>
          </div>
          <div style="display: flex; flex-direction: column; gap: 0.75rem;">
            <a href="${waLink}" target="_blank" rel="noopener noreferrer" class="btn btn-whatsapp modal-action-btn">
              Send Enquiry via WhatsApp
            </a>
            <a href="tel:+918097800430" class="btn btn-phone modal-action-btn">
              Direct Phone Call
            </a>
          </div>
        `;

        openModal('Enquiry Prepared', 'Ready for WhatsApp connect', icon, content);
      });
    }

    // Dynamic current year in footer
    const yearSpan = document.getElementById('current-year');
    if (yearSpan) {
      yearSpan.textContent = String(new Date().getFullYear());
    }
  }

  // --- CERTIFICATE SYSTEM & MODAL VIEWER ---
  function initCertificateSystem() {
    const certTrigger = document.getElementById('certificate-lightbox-trigger');
    const certInspectBtn = document.getElementById('open-cert-fullscreen-btn');
    const certModal = document.getElementById('certificate-modal');
    const certModalClose = document.getElementById('cert-modal-close-btn');

    if (!certModal) return;

    let certLastFocus = null;

    function openCertModal() {
      certLastFocus = document.activeElement;
      certModal.classList.add('modal-open');
      certModal.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';
      if (certModalClose) certModalClose.focus();
    }

    function closeCertModal() {
      certModal.classList.remove('modal-open');
      certModal.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = '';
      if (certLastFocus && typeof certLastFocus.focus === 'function') {
        certLastFocus.focus();
      }
    }

    if (certTrigger) {
      certTrigger.addEventListener('click', openCertModal);
      certTrigger.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openCertModal();
        }
      });
    }

    if (certInspectBtn) {
      certInspectBtn.addEventListener('click', openCertModal);
    }

    if (certModalClose) {
      certModalClose.addEventListener('click', closeCertModal);
    }

    certModal.addEventListener('click', (e) => {
      if (e.target === certModal) {
        closeCertModal();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && certModal.classList.contains('modal-open')) {
        closeCertModal();
      }
    });
  }

  // --- PROJECT PORTFOLIO DATA & SYSTEM ---
  // Maintainable data array. Future hotel and residential projects can easily be added here.
  const PROJECTS_DATA = [
    {
      id: 'ashiyana-wadala',
      name: 'B-14 Ashiyana CHS Ltd.',
      location: 'Wadala East, Mumbai',
      image: '/images/projects/b-14-ashiyana-chs-wadala-east.jpg',
      category: 'residential',
      categoryLabel: 'Residential Restoration',
      alt: 'B-14 Ashiyana CHS Ltd. exterior building restoration in Wadala East'
    },
    {
      id: 'om-shree-swati-dadar',
      name: 'Om Shree Swati Manor CHS Ltd.',
      location: 'Dadar West, Mumbai',
      image: '/images/projects/om-shree-swati-manor-chs-dadar-west.jpg',
      category: 'residential',
      categoryLabel: 'Residential Restoration',
      alt: 'Om Shree Swati Manor CHS Ltd. structural repair and scaffolding in Dadar West'
    },
    {
      id: 'chandra-bandra',
      name: 'Chandra CHS Ltd.',
      location: 'Bandra West, Mumbai',
      image: '/images/projects/chandra-chs-bandra-west.jpg',
      category: 'residential',
      categoryLabel: 'Residential Restoration',
      alt: 'Chandra CHS Ltd. restored apartment facade in Bandra West'
    },
    {
      id: 'vijay-vihar-chembur',
      name: 'Vijay Vihar CHS Ltd.',
      location: 'Chembur, Mumbai',
      image: '/images/projects/vijay-vihar-chs-chembur.jpg',
      category: 'residential',
      categoryLabel: 'Residential Restoration',
      alt: 'Vijay Vihar CHS Ltd. building rehabilitation and civil repairs in Chembur'
    },
    {
      id: 'prem-niwas-chunabhatti',
      name: 'Prem Niwas CHS Ltd.',
      location: 'Chunabhatti, Mumbai',
      image: '/images/projects/prem-niwas-chs-chunabhatti.jpg',
      category: 'residential',
      categoryLabel: 'Residential Restoration',
      alt: 'Prem Niwas CHS Ltd. exterior painting and waterproofing in Chunabhatti'
    },
    {
      id: 'eskay-chemicals-ghatkopar',
      name: 'Eskay Chemicals',
      location: 'Ghatkopar West, Mumbai',
      image: '/images/projects/eskay-chemicals-ghatkopar-west.jpg',
      category: 'commercial',
      categoryLabel: 'Commercial / Industrial',
      alt: 'Eskay Chemicals structural repairs and protective finishes in Ghatkopar West'
    },
    {
      id: 'deccan-madhukunj-dadar',
      name: 'Deccan Madhukunj',
      location: 'Dadar East, Mumbai',
      image: '/images/projects/deccan-madhukunj-dadar-east.jpg',
      category: 'residential',
      categoryLabel: 'Residential Restoration',
      alt: 'Deccan Madhukunj building restoration and scaffolding in Dadar East'
    },
    {
      id: 'vishal-apartment-ghatkopar',
      name: 'Vishal Apartment',
      location: 'Ghatkopar East, Mumbai',
      image: '/images/projects/vishal-apartment-ghatkopar-east.jpg',
      category: 'residential',
      categoryLabel: 'Residential Restoration',
      alt: 'Vishal Apartment exterior civil repair and facade painting in Ghatkopar East'
    },
    {
      id: 'unique-chs-trombay',
      name: 'Unique CHS',
      location: 'Trombay, Mumbai',
      image: '/images/projects/unique-chs-trombay.jpg',
      category: 'residential',
      categoryLabel: 'Residential Restoration',
      alt: 'Unique CHS restored multi-storey facade in Trombay'
    },
    {
      id: 'soyuz-complex-trombay',
      name: 'Soyuz Complex',
      location: 'Trombay, Mumbai',
      image: '/images/projects/soyuz-complex-trombay.jpg',
      category: 'residential',
      categoryLabel: 'Residential Restoration',
      alt: 'Soyuz Complex residential housing restoration in Trombay'
    },
    {
      id: 'swastik-plaza-chembur',
      name: 'Swastik Plaza',
      location: 'Chembur, Mumbai',
      image: '/images/projects/swastik-plaza-chembur.jpg',
      category: 'residential',
      categoryLabel: 'Residential Restoration',
      alt: 'Swastik Plaza residential complex facade restoration in Chembur'
    },
    {
      id: 'hari-krupa-ghatkopar',
      name: 'Hari Krupa CHS',
      location: 'Ghatkopar East, Mumbai',
      image: '/images/projects/hari-krupa-chs-ghatkopar-east.jpg',
      category: 'residential',
      categoryLabel: 'Residential Restoration',
      alt: 'Hari Krupa CHS structural repairs and external scaffolding in Ghatkopar East'
    },
    {
      id: 'sun-n-sand-juhu',
      name: 'SUN N SAND Hotel',
      location: 'Juhu, Mumbai',
      image: '/images/projects/sun-n-sand-hotel-juhu.jpg',
      category: 'hotel',
      categoryLabel: 'Hotel Restoration',
      alt: 'SUN N SAND Hotel exterior facade restoration and refurbishment in Juhu'
    },
    {
      id: 'prem-sagar-sion',
      name: 'Prem Sagar CHS',
      location: 'Sion, Mumbai',
      image: '/images/projects/prem-sagar-chs-sion.jpg',
      category: 'residential',
      categoryLabel: 'Residential Restoration',
      alt: 'Prem Sagar CHS structural facade restoration in Sion'
    },
    {
      id: 'sai-parvati-niwas-andheri',
      name: 'Sai Parvati Niwas',
      location: 'Andheri East, Mumbai',
      image: '/images/projects/sai-parvati-niwas-andheri-east.jpg',
      category: 'residential',
      categoryLabel: 'Residential Restoration',
      alt: 'Sai Parvati Niwas high-rise residential rehabilitation and plumbing restoration in Andheri East'
    }
  ];

  function initProjectPortfolio() {
    const filterButtons = document.querySelectorAll('.projects-filter-bar .filter-btn');
    const projectCards = document.querySelectorAll('.projects-portfolio-grid .project-card');
    const statusSummary = document.getElementById('filter-status-summary');

    const countAllEl = document.getElementById('count-all');
    const countResidentialEl = document.getElementById('count-residential');
    const countHotelEl = document.getElementById('count-hotel');

    // Dynamic count calculations
    const totalCount = PROJECTS_DATA.length;
    const residentialCount = PROJECTS_DATA.filter(p => p.category === 'residential').length;
    const hotelCount = PROJECTS_DATA.filter(p => p.category === 'hotel').length;

    if (countAllEl) countAllEl.textContent = String(totalCount);
    if (countResidentialEl) countResidentialEl.textContent = String(residentialCount);
    if (countHotelEl) countHotelEl.textContent = String(hotelCount);

    let activeFilter = 'all';
    let visibleProjects = [...PROJECTS_DATA];

    function applyFilter(category) {
      activeFilter = category;

      // Update buttons
      filterButtons.forEach(btn => {
        const isMatch = btn.getAttribute('data-filter') === category;
        btn.classList.toggle('active', isMatch);
        btn.setAttribute('aria-selected', isMatch ? 'true' : 'false');
      });

      // Filter cards
      let visibleCount = 0;
      projectCards.forEach(card => {
        const cardCategory = card.getAttribute('data-category');
        const shouldShow = (category === 'all') || (cardCategory === category);

        if (shouldShow) {
          card.classList.remove('is-hidden');
          card.classList.add('fade-in');
          visibleCount++;
        } else {
          card.classList.add('is-hidden');
          card.classList.remove('fade-in');
        }
      });

      // Update visible projects array for lightbox navigation
      if (category === 'all') {
        visibleProjects = [...PROJECTS_DATA];
      } else {
        visibleProjects = PROJECTS_DATA.filter(p => p.category === category);
      }

      // Update summary text
      if (statusSummary) {
        if (category === 'all') {
          statusSummary.textContent = `Showing all ${visibleCount} verified projects across Mumbai`;
        } else if (category === 'residential') {
          statusSummary.textContent = `Showing ${visibleCount} verified residential restoration projects across Mumbai`;
        } else if (category === 'hotel') {
          statusSummary.textContent = `Showing ${visibleCount} verified hotel restoration project (SUN N SAND Hotel — Juhu)`;
        }
      }
    }

    // Filter button click & keyboard handlers
    filterButtons.forEach((btn, index) => {
      btn.addEventListener('click', () => {
        const filter = btn.getAttribute('data-filter');
        applyFilter(filter);
      });

      btn.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          const nextBtn = filterButtons[(index + 1) % filterButtons.length];
          nextBtn.focus();
          applyFilter(nextBtn.getAttribute('data-filter'));
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          const prevBtn = filterButtons[(index - 1 + filterButtons.length) % filterButtons.length];
          prevBtn.focus();
          applyFilter(prevBtn.getAttribute('data-filter'));
        }
      });
    });

    // Lightbox Modal System
    const lightboxModal = document.getElementById('project-lightbox');
    const lightboxImg = document.getElementById('lightbox-img');
    const lightboxTitle = document.getElementById('lightbox-title');
    const lightboxLocation = document.getElementById('lightbox-location-text');
    const lightboxCategory = document.getElementById('lightbox-category');
    const lightboxCounter = document.getElementById('lightbox-counter');
    const lightboxClose = document.getElementById('lightbox-close');
    const lightboxPrev = document.getElementById('lightbox-prev');
    const lightboxNext = document.getElementById('lightbox-next');

    let currentLightboxIndex = 0;
    let lastFocusedElement = null;

    function openLightbox(index) {
      if (!lightboxModal || visibleProjects.length === 0) return;

      currentLightboxIndex = (index + visibleProjects.length) % visibleProjects.length;
      const project = visibleProjects[currentLightboxIndex];

      if (lightboxImg) {
        lightboxImg.src = resolveAssetUrl(project.image);
        lightboxImg.alt = project.alt || project.name;
      }
      if (lightboxTitle) lightboxTitle.textContent = project.name;
      if (lightboxLocation) lightboxLocation.textContent = project.location;
      if (lightboxCategory) {
        lightboxCategory.textContent = project.categoryLabel;
        lightboxCategory.className = `project-category-badge category-${project.category}`;
      }
      if (lightboxCounter) {
        lightboxCounter.textContent = `${currentLightboxIndex + 1} of ${visibleProjects.length}`;
      }

      lightboxModal.classList.add('lightbox-open');
      lightboxModal.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';

      if (lightboxClose) lightboxClose.focus();
    }

    function closeLightbox() {
      if (!lightboxModal) return;
      lightboxModal.classList.remove('lightbox-open');
      lightboxModal.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = '';
      if (lastFocusedElement) {
        lastFocusedElement.focus();
        lastFocusedElement = null;
      }
    }

    function stepLightbox(delta) {
      openLightbox(currentLightboxIndex + delta);
    }

    // Bind card clicks to lightbox
    projectCards.forEach(card => {
      const cardId = card.getAttribute('data-id');

      const triggerOpen = () => {
        lastFocusedElement = card;
        const targetIndex = visibleProjects.findIndex(p => p.id === cardId);
        if (targetIndex !== -1) {
          openLightbox(targetIndex);
        } else {
          // If clicked while not in visible filtered list, find in all data
          const fallbackIndex = PROJECTS_DATA.findIndex(p => p.id === cardId);
          if (fallbackIndex !== -1) {
            visibleProjects = [PROJECTS_DATA[fallbackIndex]];
            openLightbox(0);
          }
        }
      };

      card.addEventListener('click', triggerOpen);

      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          triggerOpen();
        }
      });
    });

    if (lightboxClose) lightboxClose.addEventListener('click', closeLightbox);
    if (lightboxPrev) lightboxPrev.addEventListener('click', () => stepLightbox(-1));
    if (lightboxNext) lightboxNext.addEventListener('click', () => stepLightbox(1));

    if (lightboxModal) {
      lightboxModal.addEventListener('click', (e) => {
        if (e.target === lightboxModal) closeLightbox();
      });
    }

    document.addEventListener('keydown', (e) => {
      if (!lightboxModal || !lightboxModal.classList.contains('lightbox-open')) return;

      if (e.key === 'Escape') {
        closeLightbox();
      } else if (e.key === 'ArrowLeft') {
        stepLightbox(-1);
      } else if (e.key === 'ArrowRight') {
        stepLightbox(1);
      }
    });
  }

  // --- WORK ORDERS REGISTER SYSTEM ---
  function initWorkOrders() {
    const yearButtons = document.querySelectorAll('.work-orders-year-filters .wo-filter-btn');
    const searchInput = document.getElementById('work-orders-search');
    const searchClear = document.getElementById('wo-search-clear');
    const tableRows = document.querySelectorAll('#work-orders-tbody tr');
    const summaryText = document.getElementById('work-orders-summary');
    const emptyState = document.getElementById('wo-empty-state');
    const tableEl = document.getElementById('work-orders-table');

    if (!tableRows.length) return;

    let selectedYear = 'all';
    let searchQuery = '';

    function filterWorkOrders() {
      let visibleCount = 0;
      const query = searchQuery.trim().toLowerCase();

      tableRows.forEach(row => {
        const rowYear = row.getAttribute('data-year') || '';
        const rowName = (row.getAttribute('data-name') || '').toLowerCase();
        const rowLocation = (row.getAttribute('data-location') || '').toLowerCase();
        const rowWork = (row.querySelector('.td-work')?.textContent || '').toLowerCase();
        const rowVal = (row.querySelector('.td-value')?.textContent || '').toLowerCase();

        const matchesYear = (selectedYear === 'all') || (rowYear === selectedYear);
        const matchesQuery = !query || 
          rowName.includes(query) || 
          rowLocation.includes(query) || 
          rowWork.includes(query) ||
          rowVal.includes(query);

        if (matchesYear && matchesQuery) {
          row.style.display = '';
          visibleCount++;
        } else {
          row.style.display = 'none';
        }
      });

      // Update Summary Text
      if (summaryText) {
        if (visibleCount === tableRows.length) {
          summaryText.textContent = `Showing all ${visibleCount} work orders`;
        } else if (visibleCount === 0) {
          summaryText.textContent = `No work orders found`;
        } else {
          const yearLabel = selectedYear !== 'all' ? ` for year ${selectedYear}` : '';
          const searchLabel = query ? ` matching "${query}"` : '';
          summaryText.textContent = `Showing ${visibleCount} of ${tableRows.length} work orders${yearLabel}${searchLabel}`;
        }
      }

      // Empty State Display
      if (emptyState && tableEl) {
        const tbody = tableEl.querySelector('tbody');
        if (visibleCount === 0) {
          emptyState.style.display = 'block';
          if (tbody) tbody.style.display = 'none';
        } else {
          emptyState.style.display = 'none';
          if (tbody) tbody.style.display = '';
        }
      }

      // Clear button visibility
      if (searchClear) {
        searchClear.style.display = query ? 'block' : 'none';
      }
    }

    // Year Filter Button Listeners
    yearButtons.forEach((btn, idx) => {
      btn.addEventListener('click', () => {
        selectedYear = btn.getAttribute('data-year') || 'all';

        yearButtons.forEach(b => {
          const isActive = b === btn;
          b.classList.toggle('active', isActive);
          b.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });

        filterWorkOrders();
      });

      btn.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          const nextBtn = yearButtons[(idx + 1) % yearButtons.length];
          nextBtn.focus();
          nextBtn.click();
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          const prevBtn = yearButtons[(idx - 1 + yearButtons.length) % yearButtons.length];
          prevBtn.focus();
          prevBtn.click();
        }
      });
    });

    // Search Input Listener
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value;
        filterWorkOrders();
      });

      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && searchInput.value) {
          e.preventDefault();
          searchInput.value = '';
          searchQuery = '';
          filterWorkOrders();
        }
      });
    }

    // Search Clear Button Listener
    if (searchClear) {
      searchClear.addEventListener('click', () => {
        if (searchInput) {
          searchInput.value = '';
          searchQuery = '';
          searchInput.focus();
          filterWorkOrders();
        }
      });
    }
  }

  // --- Initialization ---
  function init() {
    if (window.scrollY <= 2) {
      targetVirtualScroll = 0;
      currentVirtualScroll = 0;
      currentFrameIndex = 1;
    }

    resizeCanvas();

    // 1. Immediately request Frame 1
    fetchFrame(1);

    // 2. Start preloading the neighborhood around frame 1
    updatePriorityPreload(1);

    // 3. Start high-throughput background preloader pump
    pumpLoader();

    // 4. Input listeners with smooth completion-aware transitions
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onWindowScroll, { passive: true });
    window.addEventListener('resize', () => {
      resizeCanvas();
      updateUIState();
    }, { passive: true });

    // 5. Initialize Navigation, Form, Certificate, Project & Work Order Systems
    initNavigation();
    initEnquirySystem();
    initCertificateSystem();
    initProjectPortfolio();
    initWorkOrders();

    updateUIState();
    requestRender();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
