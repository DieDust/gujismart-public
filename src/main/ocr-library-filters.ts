export function buildOcrIncompleteCondition(documentAlias = 'd'): string {
  return `COALESCE(${documentAlias}.ocr_status, '') <> 'completed'`
}

export function buildOcrNeedsRepairCondition(documentAlias = 'd'): string {
  return `(
    COALESCE(${documentAlias}.ocr_status, '') = 'completed'
    AND (
      NOT EXISTS (
        SELECT 1
        FROM pages p_ocr_repair_any
        WHERE p_ocr_repair_any.doc_id = ${documentAlias}.id
      )
      OR EXISTS (
        SELECT 1
        FROM pages p_ocr_repair
        WHERE p_ocr_repair.doc_id = ${documentAlias}.id
          AND COALESCE(p_ocr_repair.ocr_status, '') <> 'completed'
      )
      OR (
        TRIM(COALESCE(${documentAlias}.error_message, '')) <> ''
        AND LOWER(${documentAlias}.error_message) LIKE '%ocr%'
      )
    )
  )`
}
