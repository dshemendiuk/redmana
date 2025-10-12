
// Redmana extension content script
console.log("Redmana: content.js loaded. Injecting initializer script.");

const HEADER_ROW_SELECTOR = "table.list.issues-board > thead > tr";

function injectScript() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('jquery-initializer.js');
    document.head.appendChild(script);
    script.remove();
    console.log("Redmana: Initializer script injected.");
}

// --- Main Execution ---
function waitForBoardAndInject() {
    let attempts = 0;
    const maxAttempts = 50; // Try for 10 seconds
    const interval = setInterval(() => {
        const board = document.querySelector(HEADER_ROW_SELECTOR);
        if (board) {
            clearInterval(interval);
            injectScript();
        } else if (++attempts > maxAttempts) {
            clearInterval(interval);
            console.warn("Redmana: Agile board not found after 10 seconds.");
        }
    }, 200);
}

if (window.location.pathname.includes('/agile/board')) {
    if (document.readyState === 'complete') {
        waitForBoardAndInject();
    } else {
        window.addEventListener('load', waitForBoardAndInject);
    }
}

// --- Feature: Style "Update task" button ---

function styleUpdateButton() {
    const buttonSelector = ".contextual > a.icon.icon-edit";
    
    let attempts = 0;
    const maxAttempts = 50; // Try for 10 seconds
    const interval = setInterval(() => {
        const buttons = document.querySelectorAll(buttonSelector);
        if (buttons.length > 0) {
            clearInterval(interval);
            buttons.forEach(button => {
                const label = button.querySelector('.icon-label');
                if (label) {
                    label.textContent = "Update task";
                } else {
                    // Fallback if the structure is different
                    button.textContent = "Update task";
                }
                button.classList.add("redmana-primary-button");
            });
            console.log(`Redmana: Styled ${buttons.length} 'Update task' button(s).`);
        } else if (++attempts > maxAttempts) {
            clearInterval(interval);
            console.warn("Redmana: 'Update task' button not found.");
        }
    }, 200);
}

if (window.location.pathname.includes('/issues/')) {
    styleUpdateButton();
}

// --- Feature: Image Lightbox ---

function initLightbox() {
    document.body.addEventListener('click', function(event) {
        const thumbnailLink = event.target.closest('div.thumbnails a');

        if (!thumbnailLink) {
            return; // Click was not on a thumbnail
        }

        event.preventDefault();

        // Construct the correct download URL
        const attachmentHref = thumbnailLink.getAttribute('href');
        const attachmentId = attachmentHref.split('/').pop();
        const imgTag = thumbnailLink.querySelector('img');

        if (!imgTag || !attachmentId) {
            console.error("Redmana: Couldn't construct lightbox URL.");
            return;
        }

        let filename = imgTag.getAttribute('title');
        if (!filename) {
            // Fallback to the 'alt' attribute if 'title' is missing
            filename = imgTag.getAttribute('alt');
        }

        if (!filename) {
            console.error("Redmana: Couldn't get filename from title or alt attributes.");
            return;
        }

        const imageUrl = `/attachments/download/${attachmentId}/${filename}`;

        // Create lightbox elements
        const overlay = document.createElement('div');
        overlay.className = 'redmana-lightbox-overlay';

        const content = document.createElement('div');
        content.className = 'redmana-lightbox-content';

        const img = document.createElement('img');
        img.src = imageUrl;

        content.appendChild(img);
        overlay.appendChild(content);

        // Close lightbox when overlay is clicked
        overlay.addEventListener('click', () => {
            overlay.remove();
        });

        document.body.appendChild(overlay);
    });
    console.log("Redmana: Lightbox initialized.");
}

// Initialize the lightbox feature on all pages
initLightbox();

