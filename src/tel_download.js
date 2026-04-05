// ==UserScript==
// @name         Telegram Media Downloader
// @name:en      Telegram Media Downloader
// @name:zh-CN   Telegram 受限图片视频下载器
// @name:zh-TW   Telegram 受限圖片影片下載器
// @name:ru      Telegram: загрузчик медиафайлов
// @version      1.212
// @namespace    https://github.com/Neet-Nestor/Telegram-Media-Downloader
// @description  Download images, GIFs, videos, and voice messages on the Telegram webapp from private channels that disable downloading and restrict saving content
// @description:en  Download images, GIFs, videos, and voice messages on the Telegram webapp from private channels that disable downloading and restrict saving content
// @description:ru Загружайте изображения, GIF-файлы, видео и голосовые сообщения в веб-приложении Telegram из частных каналов, которые отключили загрузку и ограничили сохранение контента
// @description:zh-CN 从禁止下载的Telegram频道中下载图片、视频及语音消息
// @description:zh-TW 從禁止下載的 Telegram 頻道中下載圖片、影片及語音訊息
// @author       Nestor Qin
// @license      GNU GPLv3
// @website      https://github.com/Neet-Nestor/Telegram-Media-Downloader
// @match        https://web.telegram.org/*
// @match        https://webk.telegram.org/*
// @match        https://webz.telegram.org/*
// @icon         https://img.icons8.com/color/452/telegram-app--v5.png
// @grant        none
// ==/UserScript==


(function () {
  const logger = {
    info: (message, fileName = null) => {
      console.log(
        `[Tel Download] ${fileName ? `${fileName}: ` : ""}${message}`
      );
    },
    error: (message, fileName = null) => {
      console.error(
        `[Tel Download] ${fileName ? `${fileName}: ` : ""}${message}`
      );
    },
  };

  // Unicode values for icons (used in /k/ app)
  // https://github.com/morethanwords/tweb/blob/master/src/icons.ts
  const DOWNLOAD_ICON = "\ue979";
  const FORWARD_ICON = "\ue99a";
  const contentRangeRegex = /^bytes (\d+)-(\d+)\/(\d+)$/;
  const REFRESH_DELAY = 500;
  const MAX_CONCURRENT_DOWNLOADS = 3;
  const MAX_BLOB_SIZE = 2 * 1024 * 1024 * 1024; // 2GB limit for in-memory downloads
  let _activeDownloads = 0;

  const hashCode = (s) => {
    var h = 0,
      l = s.length,
      i = 0;
    if (l > 0) {
      while (i < l) {
        h = ((h << 5) - h + s.charCodeAt(i++)) | 0;
      }
    }
    return h >>> 0;
  };

  const generateId = () =>
    (Math.random() + 1).toString(36).substring(2, 10) +
    "_" +
    Date.now().toString();

  const extractFileName = (url, defaultExtension) => {
    try {
      const lastSegment = url.split("/").pop();
      const metadata = JSON.parse(decodeURIComponent(lastSegment));
      if (metadata.fileName) return metadata.fileName;
    } catch (e) {
      // Invalid JSON string, fall through to default
    }
    return hashCode(url).toString(36) + "." + defaultExtension;
  };

  const triggerBrowserDownload = (blobUrl, fileName) => {
    const a = document.createElement("a");
    document.body.appendChild(a);
    a.href = blobUrl;
    a.download = fileName;
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(blobUrl);
  };

  const supportsFileSystemAccess = () =>
    "showSaveFilePicker" in unsafeWindow &&
    (() => {
      try {
        return unsafeWindow.self === unsafeWindow.top;
      } catch {
        return false;
      }
    })();

  // --- Progress Bar ---

  const createProgressBar = (downloadId, fileName) => {
    const isDarkMode =
      document.querySelector("html").classList.contains("night") ||
      document.querySelector("html").classList.contains("theme-dark");
    const container = document.getElementById(
      "tel-downloader-progress-bar-container"
    );
    const innerContainer = document.createElement("div");
    innerContainer.id = "tel-downloader-progress-" + downloadId;
    innerContainer.style.width = "20rem";
    innerContainer.style.marginTop = "0.4rem";
    innerContainer.style.padding = "0.6rem";
    innerContainer.style.backgroundColor = isDarkMode
      ? "rgba(0,0,0,0.3)"
      : "rgba(0,0,0,0.6)";

    const flexContainer = document.createElement("div");
    flexContainer.style.display = "flex";
    flexContainer.style.justifyContent = "space-between";

    const title = document.createElement("p");
    title.className = "filename";
    title.style.margin = 0;
    title.style.color = "white";
    title.innerText = fileName;

    const closeButton = document.createElement("div");
    closeButton.style.cursor = "pointer";
    closeButton.style.fontSize = "1.2rem";
    closeButton.style.color = isDarkMode ? "#8a8a8a" : "white";
    closeButton.innerHTML = "&times;";
    closeButton.onclick = function () {
      container.removeChild(innerContainer);
    };

    const progressBar = document.createElement("div");
    progressBar.className = "progress";
    progressBar.style.backgroundColor = "#e2e2e2";
    progressBar.style.position = "relative";
    progressBar.style.width = "100%";
    progressBar.style.height = "1.6rem";
    progressBar.style.borderRadius = "2rem";
    progressBar.style.overflow = "hidden";

    const counter = document.createElement("p");
    counter.style.position = "absolute";
    counter.style.zIndex = 5;
    counter.style.left = "50%";
    counter.style.top = "50%";
    counter.style.transform = "translate(-50%, -50%)";
    counter.style.margin = 0;
    counter.style.color = "black";
    const progress = document.createElement("div");
    progress.style.position = "absolute";
    progress.style.height = "100%";
    progress.style.width = "0%";
    progress.style.backgroundColor = "#6093B5";

    progressBar.appendChild(counter);
    progressBar.appendChild(progress);
    flexContainer.appendChild(title);
    flexContainer.appendChild(closeButton);
    innerContainer.appendChild(flexContainer);
    innerContainer.appendChild(progressBar);
    container.appendChild(innerContainer);
  };

  const updateProgress = (downloadId, fileName, progress) => {
    const innerContainer = document.getElementById(
      "tel-downloader-progress-" + downloadId
    );
    innerContainer.querySelector("p.filename").innerText = fileName;
    const progressBar = innerContainer.querySelector("div.progress");
    progressBar.querySelector("p").innerText = progress + "%";
    progressBar.querySelector("div").style.width = progress + "%";
  };

  const setProgressStatus = (downloadId, label, color) => {
    const progressBar = document
      .getElementById("tel-downloader-progress-" + downloadId)
      .querySelector("div.progress");
    progressBar.querySelector("p").innerText = label;
    progressBar.querySelector("div").style.backgroundColor = color;
    progressBar.querySelector("div").style.width = "100%";
  };

  const completeProgress = (downloadId) => {
    setProgressStatus(downloadId, "Completed", "#B6C649");
  };

  const abortProgress = (downloadId) => {
    setProgressStatus(downloadId, "Aborted", "#D16666");
  };

  // --- Unified media download (video/audio) ---

  const tel_download_media = (url, mediaType) => {
    if (_activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
      logger.error(
        "Max concurrent downloads reached. Please wait for a download to finish.",
        null
      );
      return;
    }
    _activeDownloads++;

    const defaultExtension = mediaType === "audio" ? "ogg" : "mp4";
    let _blobs = [];
    let _next_offset = 0;
    let _total_size = null;
    let _mimeType = mediaType + "/" + defaultExtension;
    let fileName = extractFileName(url, defaultExtension);

    const downloadId = generateId();

    logger.info(`URL: ${url}`, fileName);

    const cleanup = () => {
      _activeDownloads--;
      _blobs = [];
    };

    const fetchNextPart = (_writable) => {
      fetch(url, {
        method: "GET",
        headers: {
          Range: `bytes=${_next_offset}-`,
        },
      })
        .then((res) => {
          if (![200, 206].includes(res.status)) {
            throw new Error(
              "Non 200/206 response was received: " + res.status
            );
          }

          const mime = res.headers.get("Content-Type").split(";")[0];
          if (!mime.startsWith(mediaType + "/")) {
            throw new Error(
              "Get non " + mediaType + " response with MIME type " + mime
            );
          }
          _mimeType = mime;

          // Update file extension from actual MIME type
          const detectedExtension = mime.split("/")[1];
          fileName =
            fileName.substring(0, fileName.indexOf(".") + 1) +
            detectedExtension;

          const contentRange = res.headers.get("Content-Range");
          if (contentRange) {
            const match = contentRange.match(contentRangeRegex);
            const startOffset = parseInt(match[1]);
            const endOffset = parseInt(match[2]);
            const totalSize = parseInt(match[3]);

            if (startOffset !== _next_offset) {
              logger.error("Gap detected between responses.", fileName);
              logger.info("Last offset: " + _next_offset, fileName);
              logger.info("New start offset " + match[1], fileName);
              throw new Error("Gap detected between responses.");
            }
            if (_total_size && totalSize !== _total_size) {
              logger.error("Total size differs", fileName);
              throw new Error("Total size differs");
            }

            _next_offset = endOffset + 1;
            _total_size = totalSize;
          } else {
            // Full content response (200) -- single part
            const contentLength = parseInt(res.headers.get("Content-Length"));
            _total_size = contentLength;
            _next_offset = contentLength;
          }

          logger.info(
            `Get response: ${res.headers.get(
              "Content-Length"
            )} bytes data from ${res.headers.get("Content-Range")}`,
            fileName
          );
          logger.info(
            `Progress: ${((_next_offset * 100) / _total_size).toFixed(0)}%`,
            fileName
          );
          updateProgress(
            downloadId,
            fileName,
            ((_next_offset * 100) / _total_size).toFixed(0)
          );
          return res.blob();
        })
        .then((resBlob) => {
          if (_writable !== null) {
            return _writable.write(resBlob);
          } else {
            if (_next_offset > MAX_BLOB_SIZE) {
              throw new Error(
                "File too large for in-memory download (" +
                  Math.round(_next_offset / 1024 / 1024) +
                  "MB). Use a browser that supports File System Access API."
              );
            }
            _blobs.push(resBlob);
          }
        })
        .then(() => {
          if (!_total_size) {
            throw new Error("_total_size is NULL");
          }

          if (_next_offset < _total_size) {
            fetchNextPart(_writable);
          } else {
            if (_writable !== null) {
              _writable.close().then(() => {
                logger.info("Download finished", fileName);
              });
            } else {
              save();
            }
            completeProgress(downloadId);
            cleanup();
          }
        })
        .catch((reason) => {
          logger.error(reason, fileName);
          abortProgress(downloadId);
          cleanup();
        });
    };

    const save = () => {
      logger.info(
        "Finish downloading blobs. Concatenating blobs and downloading...",
        fileName
      );

      const blob = new Blob(_blobs, { type: _mimeType });
      const blobUrl = window.URL.createObjectURL(blob);

      logger.info("Final blob size: " + blob.size + " bytes", fileName);

      triggerBrowserDownload(blobUrl, fileName);

      logger.info("Download triggered", fileName);
    };

    if (supportsFileSystemAccess()) {
      unsafeWindow
        .showSaveFilePicker({
          suggestedName: fileName,
        })
        .then((handle) => {
          handle
            .createWritable()
            .then((writable) => {
              fetchNextPart(writable);
              createProgressBar(downloadId, fileName);
            })
            .catch((err) => {
              logger.error(err.name + " " + err.message);
              cleanup();
            });
        })
        .catch((err) => {
          if (err.name !== "AbortError") {
            logger.error(err.name + " " + err.message);
          }
          cleanup();
        });
    } else {
      fetchNextPart(null);
      createProgressBar(downloadId, fileName);
    }
  };

  const tel_download_video = (url) => {
    tel_download_media(url, "video");
  };

  const tel_download_audio = (url) => {
    tel_download_media(url, "audio");
  };

  const tel_download_image = (imageUrl) => {
    const fileName =
      (Math.random() + 1).toString(36).substring(2, 10) + ".jpeg"; // assume jpeg

    triggerBrowserDownload(imageUrl, fileName);

    logger.info("Download triggered", fileName);
  };

  const showNotification = (message, isError = false) => {
    const container = document.getElementById("tel-downloader-progress-bar-container");
    if (!container) return;
    const notification = document.createElement("div");
    notification.style.cssText =
      "width:20rem;margin-top:0.4rem;padding:0.8rem;color:white;border-radius:0.4rem;" +
      "cursor:pointer;font-size:0.85rem;background-color:" +
      (isError ? "rgba(180,50,50,0.9)" : "rgba(50,50,50,0.9)");
    notification.textContent = message;
    notification.onclick = () => notification.remove();
    container.appendChild(notification);
    setTimeout(() => { if (notification.parentNode) notification.remove(); }, 5000);
  };

  const tel_download_native = (url, fileName) => {
    try {
      logger.info("Native download: " + fileName);
      const a = document.createElement("a");
      document.body.appendChild(a);
      a.href = url;
      a.download = fileName || "download";
      a.click();
      document.body.removeChild(a);
    } catch (e) {
      logger.error("Download failed: " + e.message, fileName);
      showNotification("Download failed: " + e.message, true);
    }
  };

  logger.info("Initialized");

  // --- Shared UI helpers ---

  const buildStreamUrl = (doc) => {
    return (
      "stream/" +
      encodeURIComponent(
        JSON.stringify({
          dcId: doc.dc_id,
          location: {
            _: "inputDocumentFileLocation",
            id: doc.id,
            access_hash: doc.access_hash,
            file_reference: Array.from(doc.file_reference),
          },
          size: doc.size,
          mimeType: doc.mime_type,
          fileName: doc.file_name,
        })
      )
    );
  };

  const findDocInBubble = (bubble) => {
    // 1. Check all elements for .message.media.document (audio-element, etc.)
    const elements = bubble.querySelectorAll("*");
    for (const el of elements) {
      if (el.message?.media?.document) {
        return el.message.media.document;
      }
    }
    // 2. Try Telegram's internal managers via any audio-element on the page
    const mid = parseInt(bubble.dataset.mid);
    const peerId = parseInt(bubble.dataset.peerId);
    if (mid && peerId) {
      const anyAudioEl = document.querySelector("audio-element");
      if (anyAudioEl?.managers) {
        try {
          const msg =
            anyAudioEl.managers.appMessagesManager?.getMessageByPeer?.(
              peerId,
              mid
            );
          if (msg?.media?.document) return msg.media.document;
        } catch (e) {
          /* internal API unavailable */
        }
      }
    }
    return null;
  };

  const createBubbleDownloadButton = (doc, isOverlay = false) => {
    const streamUrl = buildStreamUrl(doc);
    const downloadButton = document.createElement("button");
    downloadButton.className = "btn-icon tgico-download _tel_download_button";
    downloadButton.innerHTML = `<span class="tgico button-icon">${DOWNLOAD_ICON}</span>`;
    downloadButton.setAttribute("type", "button");
    downloadButton.setAttribute("title", "Download " + (doc.file_name || ""));
    downloadButton.setAttribute("aria-label", "Download");
    if (isOverlay) {
      downloadButton.style.cssText =
        "position:absolute;top:4px;right:4px;z-index:2;background:rgba(0,0,0,0.5);color:white;border-radius:50%;";
    }
    downloadButton.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      tel_download_native(streamUrl, doc.file_name);
    };
    return downloadButton;
  };

  /**
   * Manages the download button in a toolbar: adds, updates, or removes
   * a custom tel-download button based on whether a native download button
   * already exists and whether the URL has changed.
   */
  const syncToolbarDownloadButton = (
    toolbar,
    downloadUrl,
    downloadFn,
    newButton
  ) => {
    const existingTelButton = toolbar.querySelector("button.tel-download");
    if (existingTelButton) {
      if (toolbar.querySelectorAll('button[title="Download"]').length > 1) {
        // Native download button exists, remove ours
        existingTelButton.remove();
      } else if (
        existingTelButton.getAttribute("data-tel-download-url") !== downloadUrl
      ) {
        // URL changed, update existing button
        existingTelButton.onclick = () => downloadFn(downloadUrl);
        existingTelButton.setAttribute("data-tel-download-url", downloadUrl);
      }
    } else if (!toolbar.querySelector('button[title="Download"]')) {
      // No download button at all, add ours
      newButton.setAttribute("data-tel-download-url", downloadUrl);
      newButton.onclick = () => downloadFn(downloadUrl);
      toolbar.prepend(newButton);
    }
  };

  // --- For webz /a/ webapp ---

  setInterval(() => {
    // Stories
    const storiesContainer = document.getElementById("StoryViewer");
    if (storiesContainer) {
      const createDownloadButton = () => {
        const downloadIcon = document.createElement("i");
        downloadIcon.className = "icon icon-download";
        const downloadButton = document.createElement("button");
        downloadButton.className =
          "Button TkphaPyQ tiny translucent-white round tel-download";
        downloadButton.appendChild(downloadIcon);
        downloadButton.setAttribute("type", "button");
        downloadButton.setAttribute("title", "Download");
        downloadButton.setAttribute("aria-label", "Download");
        downloadButton.onclick = () => {
          // 1. Story with video
          const video = storiesContainer.querySelector("video");
          const videoSrc =
            video?.src ||
            video?.currentSrc ||
            video?.querySelector("source")?.src;
          if (videoSrc) {
            tel_download_video(videoSrc);
          } else {
            // 2. Story with image
            const images = storiesContainer.querySelectorAll("img.PVZ8TOWS");
            if (images.length > 0) {
              const imageSrc = images[images.length - 1]?.src;
              if (imageSrc) tel_download_image(imageSrc);
            }
          }
        };
        return downloadButton;
      };

      const storyHeader =
        storiesContainer.querySelector(".GrsJNw3y") ||
        storiesContainer.querySelector(".DropdownMenu").parentNode;
      if (storyHeader && !storyHeader.querySelector(".tel-download")) {
        storyHeader.insertBefore(
          createDownloadButton(),
          storyHeader.querySelector("button")
        );
      }
    }

    // All media opened are located in .media-viewer-movers > .media-viewer-aspecter
    const mediaContainer = document.querySelector(
      "#MediaViewer .MediaViewerSlide--active"
    );
    const mediaViewerActions = document.querySelector(
      "#MediaViewer .MediaViewerActions"
    );
    if (!mediaContainer || !mediaViewerActions) return;

    // Videos in channels
    const videoPlayer = mediaContainer.querySelector(
      ".MediaViewerContent > .VideoPlayer"
    );
    const img = mediaContainer.querySelector(".MediaViewerContent > div > img");

    // 1. Video player detected - Video or GIF
    // container > .MediaViewerSlides > .MediaViewerSlide > .MediaViewerContent > .VideoPlayer > video[src]
    const downloadIcon = document.createElement("i");
    downloadIcon.className = "icon icon-download";
    const downloadButton = document.createElement("button");
    downloadButton.className =
      "Button smaller translucent-white round tel-download";
    downloadButton.setAttribute("type", "button");
    downloadButton.setAttribute("title", "Download");
    downloadButton.setAttribute("aria-label", "Download");
    downloadButton.appendChild(downloadIcon);

    if (videoPlayer) {
      const videoUrl = videoPlayer.querySelector("video").currentSrc;
      downloadButton.setAttribute("data-tel-download-url", videoUrl);
      downloadButton.onclick = () => {
        tel_download_video(videoPlayer.querySelector("video").currentSrc);
      };

      // Add download button to video controls
      const controls = videoPlayer.querySelector(".VideoPlayerControls");
      if (controls) {
        const buttons = controls.querySelector(".buttons");
        if (!buttons.querySelector("button.tel-download")) {
          const spacer = buttons.querySelector(".spacer");
          spacer.after(downloadButton);
        }
      }

      // Add/Update/Remove download button in topbar
      syncToolbarDownloadButton(
        mediaViewerActions,
        videoUrl,
        tel_download_video,
        downloadButton
      );
    } else if (img && img.src) {
      downloadButton.setAttribute("data-tel-download-url", img.src);
      downloadButton.onclick = () => {
        tel_download_image(img.src);
      };

      // Add/Update/Remove download button in topbar
      syncToolbarDownloadButton(
        mediaViewerActions,
        img.src,
        tel_download_image,
        downloadButton
      );
    }
  }, REFRESH_DELAY);

  // --- For webk /k/ webapp ---

  setInterval(() => {
    /* Pinned audio bar download button */
    const pinnedAudio = document.body.querySelector(".pinned-audio");
    if (pinnedAudio && !pinnedAudio.querySelector("._tel_download_button")) {
      const pinnedTitle = (
        pinnedAudio.querySelector(".pinned-container-title") ||
        pinnedAudio.querySelector(".pinned-audio-title")
      )?.textContent?.trim();
      if (pinnedTitle) {
        let matchedDoc = null;
        const audioEls = document.body.querySelectorAll("audio-element");
        for (const ae of audioEls) {
          const doc = ae.message?.media?.document;
          if (doc && doc.file_name === pinnedTitle) {
            matchedDoc = doc;
            break;
          }
        }
        if (matchedDoc) {
          const downloadBtn = document.createElement("button");
          downloadBtn.className = "btn-icon tgico-download _tel_download_button";
          downloadBtn.innerHTML = `<span class="tgico button-icon">${DOWNLOAD_ICON}</span>`;
          downloadBtn.setAttribute("type", "button");
          downloadBtn.setAttribute("title", "Download");
          downloadBtn.onclick = (e) => {
            e.stopPropagation();
            tel_download_native(buildStreamUrl(matchedDoc), matchedDoc.file_name);
          };
          const utils = pinnedAudio.querySelector(".pinned-container-wrapper-utils");
          if (utils) utils.appendChild(downloadBtn);
        }
      }
    }

    /* Add download buttons to all document/audio/video bubbles */
    const bubbles = document.body.querySelectorAll(
      ".bubble.audio-message, .bubble.document-message, .bubble.video"
    );
    bubbles.forEach((bubble) => {
      if (bubble.querySelector("._tel_download_button")) return;

      const doc = findDocInBubble(bubble);
      if (!doc || !doc.dc_id || !doc.id) return;

      const isVideo = bubble.classList.contains("video") && !bubble.classList.contains("document-message");
      if (isVideo) {
        // Overlay button on the video thumbnail
        const attachment = bubble.querySelector(".attachment");
        if (attachment) {
          attachment.style.position = "relative";
          attachment.appendChild(createBubbleDownloadButton(doc, true));
        }
      } else {
        const wrapper =
          bubble.querySelector(".document-wrapper") ||
          bubble.querySelector(".bubble-content");
        if (wrapper) {
          wrapper.appendChild(createBubbleDownloadButton(doc));
        }
      }
    });

    // Stories
    const storiesContainer = document.getElementById("stories-viewer");
    if (storiesContainer) {
      const createDownloadButton = () => {
        const downloadButton = document.createElement("button");
        downloadButton.className = "btn-icon rp tel-download";
        downloadButton.innerHTML = `<span class="tgico">${DOWNLOAD_ICON}</span><div class="c-ripple"></div>`;
        downloadButton.setAttribute("type", "button");
        downloadButton.setAttribute("title", "Download");
        downloadButton.setAttribute("aria-label", "Download");
        downloadButton.onclick = () => {
          // 1. Story with video
          const video = storiesContainer.querySelector("video.media-video");
          const videoSrc =
            video?.src ||
            video?.currentSrc ||
            video?.querySelector("source")?.src;
          if (videoSrc) {
            tel_download_video(videoSrc);
          } else {
            // 2. Story with image
            const imageSrc =
              storiesContainer.querySelector("img.media-photo")?.src;
            if (imageSrc) tel_download_image(imageSrc);
          }
        };
        return downloadButton;
      };

      const storyHeader = storiesContainer.querySelector(
        "[class^='_ViewerStoryHeaderRight']"
      );
      if (storyHeader && !storyHeader.querySelector(".tel-download")) {
        storyHeader.prepend(createDownloadButton());
      }

      const storyFooter = storiesContainer.querySelector(
        "[class^='_ViewerStoryFooterRight']"
      );
      if (storyFooter && !storyFooter.querySelector(".tel-download")) {
        storyFooter.prepend(createDownloadButton());
      }
    }

    // All media opened are located in .media-viewer-movers > .media-viewer-aspecter
    const mediaContainer = document.querySelector(".media-viewer-whole");
    if (!mediaContainer) return;
    const mediaAspecter = mediaContainer.querySelector(
      ".media-viewer-movers .media-viewer-aspecter"
    );
    const mediaButtons = mediaContainer.querySelector(
      ".media-viewer-topbar .media-viewer-buttons"
    );
    if (!mediaAspecter || !mediaButtons) return;

    // Query hidden buttons and unhide them
    const hiddenButtons = mediaButtons.querySelectorAll("button.btn-icon.hide");
    let onDownload = null;
    for (const btn of hiddenButtons) {
      btn.classList.remove("hide");
      if (btn.textContent === FORWARD_ICON) {
        btn.classList.add("tgico-forward");
      }
      if (btn.textContent === DOWNLOAD_ICON) {
        btn.classList.add("tgico-download");
        // Use official download button
        onDownload = () => {
          btn.click();
        };
        logger.info("onDownload", onDownload);
      }
    }

    if (mediaAspecter.querySelector(".ckin__player")) {
      // 1. Video player detected - Video and it has finished initial loading
      // container > .ckin__player > video[src]

      // add download button to videos
      const controls = mediaAspecter.querySelector(
        ".default__controls.ckin__controls"
      );
      if (controls && !controls.querySelector(".tel-download")) {
        const brControls = controls.querySelector(
          ".bottom-controls .right-controls"
        );
        const downloadButton = document.createElement("button");
        downloadButton.className =
          "btn-icon default__button tgico-download tel-download";
        downloadButton.innerHTML = `<span class="tgico">${DOWNLOAD_ICON}</span>`;
        downloadButton.setAttribute("type", "button");
        downloadButton.setAttribute("title", "Download");
        downloadButton.setAttribute("aria-label", "Download");
        if (onDownload) {
          downloadButton.onclick = onDownload;
        } else {
          downloadButton.onclick = () => {
            tel_download_video(mediaAspecter.querySelector("video").src);
          };
        }
        brControls.prepend(downloadButton);
      }
    } else if (
      mediaAspecter.querySelector("video") &&
      !mediaButtons.querySelector("button.btn-icon.tgico-download")
    ) {
      // 2. Video HTML element detected, could be either GIF or unloaded video
      // container > video[src]
      const downloadButton = document.createElement("button");
      downloadButton.className = "btn-icon tgico-download tel-download";
      downloadButton.innerHTML = `<span class="tgico button-icon">${DOWNLOAD_ICON}</span>`;
      downloadButton.setAttribute("type", "button");
      downloadButton.setAttribute("title", "Download");
      downloadButton.setAttribute("aria-label", "Download");
      if (onDownload) {
        downloadButton.onclick = onDownload;
      } else {
        downloadButton.onclick = () => {
          tel_download_video(mediaAspecter.querySelector("video").src);
        };
      }
      mediaButtons.prepend(downloadButton);
    } else if (!mediaButtons.querySelector("button.btn-icon.tgico-download")) {
      // 3. Image without download button detected
      const imgElement =
        mediaAspecter.querySelector("img.thumbnail") ||
        mediaAspecter.querySelector("img.media-photo") ||
        mediaAspecter.querySelector("img");
      if (!onDownload && (!imgElement || !imgElement.src)) {
        return;
      }
      const downloadButton = document.createElement("button");
      downloadButton.className = "btn-icon tgico-download tel-download";
      downloadButton.innerHTML = `<span class="tgico button-icon">${DOWNLOAD_ICON}</span>`;
      downloadButton.setAttribute("type", "button");
      downloadButton.setAttribute("title", "Download");
      downloadButton.setAttribute("aria-label", "Download");
      if (onDownload) {
        downloadButton.onclick = onDownload;
      } else {
        downloadButton.onclick = () => {
          const img =
            mediaAspecter.querySelector("img.thumbnail") ||
            mediaAspecter.querySelector("img.media-photo") ||
            mediaAspecter.querySelector("img");
          if (img && img.src) tel_download_image(img.src);
        };
      }
      mediaButtons.prepend(downloadButton);
    }
  }, REFRESH_DELAY);

  // Progress bar container setup
  (function setupProgressBar() {
    const body = document.querySelector("body");
    const container = document.createElement("div");
    container.id = "tel-downloader-progress-bar-container";
    container.style.position = "fixed";
    container.style.bottom = 0;
    container.style.right = 0;
    if (location.pathname.startsWith("/k/")) {
      container.style.zIndex = 4;
    } else {
      container.style.zIndex = 1600;
    }
    body.appendChild(container);
  })();

  logger.info("Completed script setup.");
})();
