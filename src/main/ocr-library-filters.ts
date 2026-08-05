export function buildOcrIncompleteCondition(documentAlias = 'd'): string {
  return `COALESCE(${documentAlias}.ocr_status, '') <> 'completed'`
}

/**
 * Cheap page-content check for list/sidebar queries.
 *
 * Do not inspect the OCR JSON body here: large libraries would have to read
 * every payload just to render a filter. Inline text, externalized text refs,
 * and a completed status are enough to recognize a usable page.
 */
export function buildPageContentAvailableConditionStatusOnly(pageAlias = 'p'): string {
  return `(
    COALESCE(${pageAlias}.ocr_status, '') = 'completed'
    OR COALESCE(${pageAlias}.proofed_text, '') <> ''
    OR COALESCE(${pageAlias}.ocr_text, '') <> ''
    OR COALESCE(${pageAlias}.proofed_text_ref, '') <> ''
    OR COALESCE(${pageAlias}.ocr_text_ref, '') <> ''
    OR COALESCE(${pageAlias}.ocr_result_ref, '') <> ''
  )`
}

export function buildPageNeedsOcrRepairCondition(pageAlias = 'p'): string {
  return `(
    COALESCE(${pageAlias}.ocr_status, '') <> 'completed'
    AND NOT (${buildPageContentAvailableConditionStatusOnly(pageAlias)})
  )`
}

export function buildOcrNeedsRepairCondition(documentAlias = 'd'): string {
  return `(
    COALESCE(${documentAlias}.ocr_status, '') IN ('completed', 'error')
    AND (
      (
        EXISTS (
          SELECT 1
          FROM pages p_ocr_repair_any
          WHERE p_ocr_repair_any.doc_id = ${documentAlias}.id
        )
        AND EXISTS (
          SELECT 1
          FROM pages p_ocr_repair
          WHERE p_ocr_repair.doc_id = ${documentAlias}.id
            AND ${buildPageNeedsOcrRepairCondition('p_ocr_repair')}
        )
      )
      OR (
        NOT EXISTS (
          SELECT 1
          FROM pages p_ocr_repair_none
          WHERE p_ocr_repair_none.doc_id = ${documentAlias}.id
        )
        AND (
          COALESCE(${documentAlias}.ocr_status, '') = 'error'
          OR (
            TRIM(COALESCE(${documentAlias}.error_message, '')) <> ''
            AND LOWER(${documentAlias}.error_message) LIKE '%ocr%'
          )
        )
      )
    )
  )`
}
