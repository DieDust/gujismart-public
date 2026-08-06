export type TextEditorPageSave = () => boolean | void | Promise<boolean | void>

export async function saveTextEditorPage(save: TextEditorPageSave): Promise<boolean> {
  try {
    return (await Promise.resolve(save())) !== false
  } catch {
    return false
  }
}
