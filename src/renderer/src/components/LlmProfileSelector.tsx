import { useEffect, useState } from 'react'
import { Select, message } from 'antd'
import { getErrorMessage } from '@shared/errors'
import type { LlmProviderProfile } from '@shared/types'

const LLM_PROFILE_SYNC_EVENT = 'gujismart:llm-profile-changed'

interface LlmProfileSelectorProps {
  size?: 'small' | 'middle' | 'large'
  width?: number
  className?: string
}

export default function LlmProfileSelector({
  size = 'small',
  width = 180,
  className,
}: LlmProfileSelectorProps) {
  const [profiles, setProfiles] = useState<LlmProviderProfile[]>([])
  const [activeId, setActiveId] = useState('')
  const [switching, setSwitching] = useState(false)

  useEffect(() => {
    const loadProfiles = () => {
      void window.api.listLlmProviderProfiles()
        .then((state) => {
          setProfiles(state.profiles || [])
          setActiveId(state.activeId || '')
        })
        .catch(() => {})
    }

    const handleProfileSync = (event: Event) => {
      const detail = (event as CustomEvent).detail
      if (detail?.profiles) {
        setProfiles(detail.profiles || [])
        setActiveId(detail.activeId || '')
        return
      }
      loadProfiles()
    }

    loadProfiles()
    window.addEventListener(LLM_PROFILE_SYNC_EVENT, handleProfileSync)
    window.addEventListener('focus', loadProfiles)
    return () => {
      window.removeEventListener(LLM_PROFILE_SYNC_EVENT, handleProfileSync)
      window.removeEventListener('focus', loadProfiles)
    }
  }, [])

  const handleSwitch = async (profileId: string) => {
    setSwitching(true)
    try {
      const state = await window.api.switchLlmProviderProfile(profileId)
      setProfiles(state.profiles || [])
      setActiveId(state.activeId || '')
      window.dispatchEvent(new CustomEvent(LLM_PROFILE_SYNC_EVENT, { detail: state }))
      message.success(`AI 服务商已切换为：${state.current.name}`)
    } catch (error: unknown) {
      message.error(getErrorMessage(error, '切换 AI 服务商失败'))
    } finally {
      setSwitching(false)
    }
  }

  return (
    <Select
      className={className}
      size={size}
      value={activeId || undefined}
      loading={switching}
      placeholder="AI 服务商"
      style={{ width }}
      popupMatchSelectWidth={260}
      options={profiles.map((profile) => ({
        value: profile.id,
        label: `${profile.name} · ${profile.model}`,
      }))}
      onChange={(value) => void handleSwitch(value)}
      disabled={profiles.length === 0}
    />
  )
}
