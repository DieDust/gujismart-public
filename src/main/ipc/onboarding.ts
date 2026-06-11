import { ipcMain } from 'electron'
import { queryOne, run, saveDatabase } from '../database'
import type { OnboardingStep } from '../../shared/types'

export function registerOnboardingIpc(): void {
  ipcMain.handle('onboarding:getProgress', async (): Promise<OnboardingStep | null> => {
    return queryOne<OnboardingStep>("SELECT * FROM onboarding_progress")
  })

  ipcMain.handle('onboarding:getStep', async (_event, stepKey: string): Promise<OnboardingStep | null> => {
    return queryOne<OnboardingStep>('SELECT * FROM onboarding_progress WHERE step_key = ?', [stepKey])
  })

  ipcMain.handle('onboarding:completeStep', async (_event, stepKey: string): Promise<boolean> => {
    run(
      'INSERT OR REPLACE INTO onboarding_progress (step_key, completed, completed_at) VALUES (?, 1, ?)',
      [stepKey, new Date().toISOString()]
    )
    saveDatabase()
    return true
  })

  ipcMain.handle('onboarding:isCompleted', async (): Promise<boolean> => {
    const steps = ['api_key', 'api_guide', 'citation_format']
    for (const step of steps) {
      const row = queryOne<Pick<OnboardingStep, 'completed'>>('SELECT completed FROM onboarding_progress WHERE step_key = ?', [step])
      if (!row || row.completed !== 1) return false
    }
    return true
  })

  ipcMain.handle('onboarding:reset', async (): Promise<boolean> => {
    run('DELETE FROM onboarding_progress')
    saveDatabase()
    return true
  })
}
