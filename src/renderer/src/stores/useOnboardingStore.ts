import { create } from 'zustand'

interface OnboardingState {
  currentStep: number
  steps: Array<{
    key: string
    title: string
    description: string
    completed: boolean
  }>
  visible: boolean

  setCurrentStep: (step: number) => void
  completeStep: (key: string) => void
  completeSteps: (keys: string[]) => void
  setVisible: (visible: boolean) => void
  open: (step?: number) => void
  nextStep: () => void
  prevStep: () => void
  reset: () => void
}

const DEFAULT_STEPS = [
  { key: 'welcome', title: '准备开始', description: '了解 OCR、AI 和视觉 OCR 会启用哪些能力', completed: false },
  { key: 'paddle_ocr', title: 'PaddleOCR', description: '填写飞桨 OCR API Token，可跳过', completed: false },
  { key: 'ai_model', title: 'AI 模型', description: '配置问答、摘要、翻译和元数据提取使用的模型', completed: false },
  { key: 'vision_ocr', title: '视觉 OCR', description: '复杂版面可跟随 AI 配置或单独配置', completed: false },
  { key: 'finish', title: '完成', description: '确认可用功能并开始使用', completed: false },
]

export const useOnboardingStore = create<OnboardingState>((set, get) => ({
  currentStep: 0,
  steps: DEFAULT_STEPS,
  visible: false,

  setCurrentStep: (currentStep) => set({ currentStep }),
  completeStep: (key) => set((state) => ({
    steps: state.steps.map(s => s.key === key ? { ...s, completed: true } : s)
  })),
  completeSteps: (keys) => set((state) => {
    const keySet = new Set(keys)
    return {
      steps: state.steps.map(s => keySet.has(s.key) ? { ...s, completed: true } : s)
    }
  }),
  setVisible: (visible) => set({ visible }),
  open: (step = 0) => set((state) => ({
    currentStep: Math.max(0, Math.min(step, state.steps.length - 1)),
    visible: true,
  })),
  nextStep: () => set((state) => ({
    currentStep: Math.min(state.currentStep + 1, state.steps.length - 1)
  })),
  prevStep: () => set((state) => ({
    currentStep: Math.max(state.currentStep - 1, 0)
  })),
  reset: () => set({
    currentStep: 0,
    steps: DEFAULT_STEPS,
    visible: false
  })
}))
