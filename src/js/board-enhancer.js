(function($) {
    if (!$) {
        console.error('Redmana: jQuery is not available on the page.');
        return;
    }

    $(document).ready(function() {
        const HEADER_ROW_SELECTOR = "table.list.issues-board:not(.sticky) > thead > tr";
        const headerRow = $(HEADER_ROW_SELECTOR);
        const bodyRow = $('table.list.issues-board:not(.sticky) > tbody > tr');

        if (!headerRow.length || !bodyRow.length) return;

        let suppressOrderObserver = false;
        let reapplyScheduled = false;

        function getStickyHeaderRows() {
            return $('table.list.issues-board.sticky > thead > tr');
        }

        function reorderStickyColumns(orderIds) {
            if (!Array.isArray(orderIds) || !orderIds.length) return;
            const stickyRows = getStickyHeaderRows();
            if (!stickyRows.length) return;

            stickyRows.each(function() {
                const row = $(this);
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
            const orderedIds = headerRow.find('th[data-column-id]').map(function() {
                return $(this).data('column-id');
            }).get();
            localStorage.setItem('redmanaColumnOrder', JSON.stringify(orderedIds));
            console.log('Redmana: New order saved via jQuery UI.', orderedIds);
        }

        function applyColumnOrder(orderIds) {
            if (!Array.isArray(orderIds) || !orderIds.length) return false;

            const thMap = new Map();
            headerRow.find('th[data-column-id]').each(function() {
                thMap.set($(this).data('column-id').toString(), this);
            });

            const tdMap = new Map();
            bodyRow.find('td.issue-status-col[data-id]').each(function() {
                tdMap.set($(this).data('id').toString(), this);
            });

            let applied = false;
            orderIds.forEach(id => {
                const key = id.toString();
                const th = thMap.get(key);
                const td = tdMap.get(key);
                if (th) {
                    headerRow.append(th);
                    applied = true;
                }
                if (td) {
                    bodyRow.append(td);
                }
            });
            reorderStickyColumns(orderIds);
            return applied;
        }

        function applySavedColumnOrder(options = {}) {
            const { silent = false } = options;
            const orderedIds = getSavedOrder();
            if (!orderedIds) return;
            suppressOrderObserver = true;
            try {
                const applied = applyColumnOrder(orderedIds);
                if (applied && !silent) {
                    console.log('Redmana: Applied saved order via jQuery UI.');
                }
            } catch (e) {
                console.error('Redmana: Failed to apply saved order.', e);
            } finally {
                suppressOrderObserver = false;
            }
        }

        applySavedColumnOrder();

        // Capture column widths on mousedown, before sorting begins
        headerRow.on('mousedown', 'th', function() {
            headerRow.find('th').each(function() {
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
                headerRow.find('th').each(function() {
                    $(this).width($(this).data('original-width'));
                });
            },
            stop: function(event, ui) {
                // Un-freeze column widths and clear data
                headerRow.find('th').each(function() {
                    $(this).css('width', '').removeData('original-width');
                });
            },
            update: function(event, ui) {
                // Get the desired order from the headers, which are now correct in the DOM
                const newOrderIds = $(this).find('th[data-column-id]').map(function() {
                    return $(this).data('column-id').toString();
                }).get();

                // Create a map of the body columns by their data-id
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
        console.log("Redmana: jQuery UI Sortable initialized from external file.");

        function scheduleOrderReapply() {
            if (reapplyScheduled) return;
            reapplyScheduled = true;
            requestAnimationFrame(() => {
                reapplyScheduled = false;
                if (suppressOrderObserver) return;
                applySavedColumnOrder({ silent: true });
            });
        }

        const headerObserver = new MutationObserver(mutations => {
            if (suppressOrderObserver) return;
            const relevant = mutations.some(mutation => mutation.type === 'childList' &&
                (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0));
            if (!relevant) return;
            scheduleOrderReapply();
        });

        const mainThead = headerRow.closest('thead');
        if (mainThead.length) {
            headerObserver.observe(mainThead.get(0), { childList: true });
        }
        const stickyThead = $('table.list.issues-board.sticky > thead');
        if (stickyThead.length) {
            headerObserver.observe(stickyThead.get(0), { childList: true });
        }

        const boardTable = $('table.list.issues-board:not(.sticky)');
        if (boardTable.length) {
            headerObserver.observe(boardTable.get(0), { childList: true, subtree: true });
        }

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

            if (lastPointerY < threshold && window.scrollY > 0) {
                window.scrollBy(0, -scrollStep);
            } else if (lastPointerY > viewportHeight - threshold) {
                window.scrollBy(0, scrollStep);
            }

            scrollAnimationFrame = requestAnimationFrame(applyAutoScroll);
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
    });
})(window.jQuery);
