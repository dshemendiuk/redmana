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

        function saveColumnOrder() {
            const orderedIds = headerRow.find('th[data-column-id]').map(function() {
                return $(this).data('column-id');
            }).get();
            localStorage.setItem('redmanaColumnOrder', JSON.stringify(orderedIds));
            console.log('Redmana: New order saved via jQuery UI.', orderedIds);
        }

        function applySavedColumnOrder() {
            const savedOrder = localStorage.getItem('redmanaColumnOrder');
            if (!savedOrder) return;
            try {
                const orderedIds = JSON.parse(savedOrder);
                const thMap = new Map();
                headerRow.find('th[data-column-id]').each(function() {
                    thMap.set($(this).data('column-id').toString(), this);
                });

                const tdMap = new Map();
                bodyRow.find('td.issue-status-col[data-id]').each(function() {
                    tdMap.set($(this).data('id').toString(), this);
                });

                orderedIds.forEach(id => {
                    const th = thMap.get(id.toString());
                    const td = tdMap.get(id.toString());
                    if (th) headerRow.append(th);
                    if (td) bodyRow.append(td);
                });
                console.log('Redmana: Applied saved order via jQuery UI.');
            } catch (e) {
                console.error('Redmana: Failed to apply saved order.', e);
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

                // Now that the DOM is correct, save the order
                saveColumnOrder();
            }
        });
        console.log("Redmana: jQuery UI Sortable initialized from external file.");
    });
})(window.jQuery);
