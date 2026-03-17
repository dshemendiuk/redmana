(function($) {
    if (!$) {
        console.error('Redmana: jQuery is not available on the page.');
        return;
    }

    $(document).ready(function() {
        const HEADER_ROW_SELECTOR = "table.list.issues-board:not(.sticky) > thead > tr";
        const BODY_ROW_SELECTOR = "table.list.issues-board:not(.sticky) > tbody > tr";

        function getHeaderRow() { return $(HEADER_ROW_SELECTOR); }
        function getBodyRow() { return $(BODY_ROW_SELECTOR); }

        if (!getHeaderRow().length || !getBodyRow().length) return;

        let reapplyScheduled = false;
        const observerTargets = [];

        function arraysEqual(arrA, arrB) {
            if (!Array.isArray(arrA) || !Array.isArray(arrB)) return false;
            if (arrA.length !== arrB.length) return false;
            for (let i = 0; i < arrA.length; i++) {
                if (arrA[i] !== arrB[i]) return false;
            }
            return true;
        }

        function getStickyHeaderRows() {
            return $('table.list.issues-board.sticky > thead > tr');
        }

        function reorderStickyColumns(orderIds) {
            if (!Array.isArray(orderIds) || !orderIds.length) return;
            const stickyRows = getStickyHeaderRows();
            if (!stickyRows.length) return;

            stickyRows.each(function() {
                const row = $(this);
                const currentOrder = row.find('th[data-column-id]').map(function() {
                    return $(this).data('column-id').toString();
                }).get();
                if (arraysEqual(currentOrder, orderIds)) {
                    return;
                }
                const stickyMap = new Map();
                row.find('th[data-column-id]').each(function() {
                    stickyMap.set($(this).data('column-id').toString(), this);
                });

                orderIds.forEach(id => {
                    const th = stickyMap.get(id.toString());
                    if (th) {
                        row.append(th);
                    }
                });
            });
        }

        function getSavedOrder() {
            const savedOrder = localStorage.getItem('redmanaColumnOrder');
            if (!savedOrder) return null;
            try {
                const orderedIds = JSON.parse(savedOrder);
                if (!Array.isArray(orderedIds) || !orderedIds.length) return null;
                return orderedIds.map(id => id.toString());
            } catch (e) {
                console.error('Redmana: Failed to parse saved column order.', e);
                return null;
            }
        }

        function saveColumnOrder() {
            const orderedIds = getHeaderRow().find('th[data-column-id]').map(function() {
                return $(this).data('column-id');
            }).get();
            localStorage.setItem('redmanaColumnOrder', JSON.stringify(orderedIds));
            console.log('Redmana: New order saved via jQuery UI.', orderedIds);
        }

        function applyColumnOrder(orderIds) {
            if (!Array.isArray(orderIds) || !orderIds.length) return false;

            const headerRow = getHeaderRow();
            const bodyRow = getBodyRow();
            if (!headerRow.length) return false;

            const currentHeaderOrder = headerRow.find('th[data-column-id]').map(function() {
                return $(this).data('column-id').toString();
            }).get();
            const currentBodyOrder = bodyRow.find('td.issue-status-col[data-id]').map(function() {
                return $(this).data('id').toString();
            }).get();

            const headerChanged = !arraysEqual(currentHeaderOrder, orderIds);
            const bodyChanged = !arraysEqual(currentBodyOrder, orderIds);

            if (!headerChanged && !bodyChanged) {
                reorderStickyColumns(orderIds);
                return false;
            }

            const thMap = new Map();
            headerRow.find('th[data-column-id]').each(function() {
                thMap.set($(this).data('column-id').toString(), this);
            });

            const tdMap = new Map();
            bodyRow.find('td.issue-status-col[data-id]').each(function() {
                tdMap.set($(this).data('id').toString(), this);
            });

            let applied = false;
            if (headerChanged) {
                orderIds.forEach(id => {
                    const key = id.toString();
                    const th = thMap.get(key);
                    if (th) {
                        headerRow.append(th);
                        applied = true;
                    }
                });
            }
            if (bodyChanged) {
                orderIds.forEach(id => {
                    const key = id.toString();
                    const td = tdMap.get(key);
                    if (td) {
                        bodyRow.append(td);
                    }
                });
            }
            reorderStickyColumns(orderIds);
            return applied;
        }

        // Capture column widths on mousedown, before sorting begins
        function initSortable() {
            const headerRow = getHeaderRow();
            if (!headerRow.length) return;

            // Destroy existing sortable if present to avoid double-binding
            if (headerRow.data('ui-sortable') || headerRow.data('sortable')) {
                headerRow.sortable('destroy');
            }

            headerRow.off('mousedown.redmana');
            headerRow.on('mousedown.redmana', 'th', function() {
                getHeaderRow().find('th').each(function() {
                    $(this).data('original-width', $(this).width());
                });
            });

            headerRow.sortable({
                axis: 'x',
                placeholder: 'sortable-placeholder',
                tolerance: 'pointer',
                helper: 'clone',
                start: function(event, ui) {
                    // Apply the pre-captured widths
                    ui.placeholder.width(ui.helper.width());
                    $(this).find('th').each(function() {
                        $(this).width($(this).data('original-width'));
                    });
                },
                stop: function(event, ui) {
                    // Un-freeze column widths and clear data
                    $(this).find('th').each(function() {
                        $(this).css('width', '').removeData('original-width');
                    });
                },
                update: function(event, ui) {
                    // Get the desired order from the headers, which are now correct in the DOM
                    const newOrderIds = $(this).find('th[data-column-id]').map(function() {
                        return $(this).data('column-id').toString();
                    }).get();

                    // Create a map of the body columns by their data-id
                    const bodyRow = getBodyRow();
                    const bodyColumnsMap = new Map();
                    bodyRow.find('td.issue-status-col[data-id]').each(function() {
                        bodyColumnsMap.set($(this).data('id').toString(), this);
                    });

                    // Re-append the body columns in the new correct order
                    newOrderIds.forEach(id => {
                        const td = bodyColumnsMap.get(id);
                        if (td) {
                            bodyRow.append(td);
                        }
                    });

                    reorderStickyColumns(newOrderIds);

                    // Now that the DOM is correct, save the order
                    saveColumnOrder();
                }
            });
        }

        const headerObserver = new MutationObserver(mutations => {
            if (isDraggingCard) return;
            const relevant = mutations.some(mutation => {
                if (mutation.type !== 'childList') return false;
                if (mutation.addedNodes.length === 0 && mutation.removedNodes.length === 0) return false;
                const target = mutation.target;
                if (!(target instanceof Element)) return false;
                if (target.closest && target.closest('td.issue-status-col')) {
                    return false;
                }
                return true;
            });
            if (!relevant) return;
            scheduleOrderReapply();
        });

        function disconnectOrderObserver() {
            headerObserver.disconnect();
        }

        function reconnectOrderObserver() {
            observerTargets.forEach(({ target, options }) => {
                headerObserver.observe(target, options);
            });
        }

        function setupObserverTargets() {
            headerObserver.disconnect();
            observerTargets.length = 0;

            const mainThead = getHeaderRow().closest('thead');
            if (mainThead.length) {
                const opts = { childList: true };
                headerObserver.observe(mainThead.get(0), opts);
                observerTargets.push({ target: mainThead.get(0), options: opts });
            }
            const stickyThead = $('table.list.issues-board.sticky > thead');
            if (stickyThead.length) {
                const opts = { childList: true };
                headerObserver.observe(stickyThead.get(0), opts);
                observerTargets.push({ target: stickyThead.get(0), options: opts });
            }

            const boardTable = $('table.list.issues-board:not(.sticky)');
            if (boardTable.length) {
                const opts = { childList: true, subtree: true };
                headerObserver.observe(boardTable.get(0), opts);
                observerTargets.push({ target: boardTable.get(0), options: opts });
            }
        }

        function applySavedColumnOrder(options = {}) {
            const { silent = false } = options;
            const orderedIds = getSavedOrder();
            if (!orderedIds) return;
            disconnectOrderObserver();
            try {
                const applied = applyColumnOrder(orderedIds);
                if (applied) {
                    // DOM elements may have been replaced by Redmine's AJAX;
                    // re-bind sortable and observers to current elements.
                    initSortable();
                    setupObserverTargets();
                    if (!silent) {
                        console.log('Redmana: Applied saved order via jQuery UI.');
                    }
                    return;
                }
            } catch (e) {
                console.error('Redmana: Failed to apply saved order.', e);
            }
            reconnectOrderObserver();
        }

        function scheduleOrderReapply() {
            if (reapplyScheduled) return;
            reapplyScheduled = true;
            requestAnimationFrame(() => {
                reapplyScheduled = false;
                applySavedColumnOrder({ silent: true });
            });
        }

        // Initial setup
        applySavedColumnOrder();
        initSortable();
        setupObserverTargets();
        console.log("Redmana: jQuery UI Sortable initialized from external file.");

        // Auto-scroll while dragging issue cards near viewport edges
        let isDraggingCard = false;
        let lastPointerY = null;
        let scrollAnimationFrame = null;

        function updatePointerY(positionY) {
            lastPointerY = positionY;
            if (isDraggingCard && scrollAnimationFrame === null) {
                scrollAnimationFrame = requestAnimationFrame(applyAutoScroll);
            }
        }

        function applyAutoScroll() {
            if (!isDraggingCard || lastPointerY === null) {
                scrollAnimationFrame = null;
                return;
            }

            const threshold = 80;
            const scrollStep = 30;
            const viewportHeight = window.innerHeight;
            const maxScrollTop = document.documentElement.scrollHeight - viewportHeight;
            let didScroll = false;

            if (lastPointerY < threshold && window.scrollY > 0) {
                window.scrollBy(0, -scrollStep);
                didScroll = true;
            } else if (lastPointerY > viewportHeight - threshold) {
                const nextScroll = Math.min(window.scrollY + scrollStep, maxScrollTop);
                if (nextScroll !== window.scrollY) {
                    window.scrollTo(0, nextScroll);
                    didScroll = true;
                }
            }

            if (didScroll) {
                scrollAnimationFrame = requestAnimationFrame(applyAutoScroll);
            } else {
                scrollAnimationFrame = null;
            }
        }

        function stopAutoScroll() {
            isDraggingCard = false;
            lastPointerY = null;
            if (scrollAnimationFrame !== null) {
                cancelAnimationFrame(scrollAnimationFrame);
                scrollAnimationFrame = null;
            }
        }

        $(document).on('sortstart.redmana', '.issue-status-col.ui-sortable', () => {
            isDraggingCard = true;
        });

        $(document).on('sortstop.redmana sortcancel.redmana', '.issue-status-col.ui-sortable', () => {
            stopAutoScroll();
        });

        document.addEventListener('mousemove', event => {
            if (!isDraggingCard) return;
            updatePointerY(event.clientY);
        });

        document.addEventListener('touchmove', event => {
            if (!isDraggingCard) return;
            if (event.touches && event.touches.length) {
                updatePointerY(event.touches[0].clientY);
            }
        }, { passive: true });

        ['mouseup', 'touchend', 'touchcancel', 'pointerup', 'pointercancel', 'dragend'].forEach(eventType => {
            document.addEventListener(eventType, () => {
                if (!isDraggingCard) return;
                stopAutoScroll();
            }, true);
        });
    });
})(window.jQuery);
