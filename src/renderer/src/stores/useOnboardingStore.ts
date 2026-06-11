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
  setVisible: (visible: boolean) => void
  nextStep: () => void
  prevStep: () => void
  reset: () => void
}

const DEFAULT_STEPS = [
  { key: 'api_key', title: '配置 API Key', description: '填写 OCR 和 AI 大模型的 API Key', completed: false },
  { key: 'api_guide', title: '获取 API Key', description: '了解如何获取各平台的 API Key', completed: false },
  { key: 'citation_format', title: '设置引用格式', description: '选择或自定义论文引用格式', completed: false },
]

export const useOnboardingStore = create<OnboardingState>((set, get) => ({
  currentStep: 0,
  steps: DEFAULT_STEPS,
  visible: false,

  setCurrentStep: (currentStep) => set({ currentStep }),
  completeStep: (key) => set((state) => ({
    steps: state.steps.map(s => s.key === key ? { ...s, completed: true } : s)
  })),
  setVisible: (visible) => set({ visible }),
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
