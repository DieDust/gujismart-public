import { lazy, Suspense, useEffect, useState, type FormEvent } from 'react'
import type { LibraryProject } from '@shared/types'
import { PRODUCT_NAME } from '@shared/types'
import './styles/project-gate.css'

const loadAppShell = () => import('./AppShell')
const AppShell = lazy(loadAppShell)

type SelectedProjectState = {
  project: LibraryProject
  projects: LibraryProject[]
}

function WorkspaceLoading({ projectName }: { projectName: string }) {
  return (
    <div className="library-project-gate" data-workspace-loading="true">
      <div className="library-project-gate-card library-project-opening">
        <span className="library-project-spinner" aria-hidden="true" />
        <strong>正在打开 {projectName}</strong>
      </div>
    </div>
  )
}

export default function ProjectBootstrap() {
  const [projects, setProjects] = useState<LibraryProject[]>([])
  const [activeProject, setActiveProject] = useState<LibraryProject | null>(null)
  const [selectedProject, setSelectedProject] = useState<SelectedProjectState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createBusy, setCreateBusy] = useState(false)

  const loadProjects = async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const [nextProjects, nextActiveProject] = await Promise.all([
        window.api.listLibraryProjects(),
        window.api.getActiveLibraryProject(),
      ])
      setProjects(nextProjects)
      setActiveProject(nextActiveProject)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadProjects()
  }, [])

  useEffect(() => {
    if (!createOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !createBusy) setCreateOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [createBusy, createOpen])

  const openProject = async (project: LibraryProject, projectList = projects): Promise<void> => {
    if (openingProjectId) return
    setOpeningProjectId(project.id)
    setError('')
    try {
      const activated = await window.api.setActiveLibraryProject(project.id)
      setSelectedProject({
        project: activated,
        projects: projectList.map((item) => item.id === activated.id ? activated : item),
      })
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : String(openError))
      setOpeningProjectId(null)
    }
  }

  const createProject = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const name = createName.trim()
    if (!name || createBusy || openingProjectId) return
    setCreateBusy(true)
    setError('')
    try {
      const created = await window.api.createLibraryProject({ name, activate: true })
      const nextProjects = [...projects, created]
      setProjects(nextProjects)
      setCreateOpen(false)
      setCreateName('')
      setCreateBusy(false)
      await openProject(created, nextProjects)
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError))
      setCreateBusy(false)
    }
  }

  if (selectedProject) {
    return (
      <Suspense fallback={<WorkspaceLoading projectName={selectedProject.project.name} />}>
        <AppShell
          initialLibraryProject={selectedProject.project}
          initialLibraryProjects={selectedProject.projects}
        />
      </Suspense>
    )
  }

  return (
    <div className="library-project-gate">
      <div className="library-project-gate-card">
        <div className="library-project-gate-brand">
          <span className="brand-icon">智</span>
          <div>
            <strong>{PRODUCT_NAME}</strong>
            <span>选择本次要加载的文献项目</span>
          </div>
        </div>

        {loading ? (
          <div className="library-project-gate-loading" data-project-gate-loading="true">
            <span className="library-project-spinner" aria-hidden="true" />
            <span>正在读取项目...</span>
          </div>
        ) : error && projects.length === 0 ? (
          <div className="library-project-gate-error" role="alert">
            <strong>项目列表加载失败</strong>
            <span>{error}</span>
            <button type="button" onClick={() => void loadProjects()}>重试</button>
          </div>
        ) : (
          <>
            {error ? <div className="library-project-gate-inline-error" role="alert">{error}</div> : null}
            <div className="library-project-gate-list" data-project-gate-ready="true">
              {projects.map((project) => (
                <button
                  type="button"
                  key={project.id}
                  data-library-project-choice="true"
                  className={`library-project-gate-item ${activeProject?.id === project.id ? 'is-last-active' : ''}`}
                  onClick={() => void openProject(project)}
                  disabled={openingProjectId !== null || createBusy}
                >
                  <span className="library-project-gate-item-color" style={{ background: project.color }} />
                  <span className="library-project-gate-item-content">
                    <strong>{project.name}</strong>
                    <span>{project.document_count.toLocaleString()} 篇文献{project.is_default ? ' · 旧版文献默认归入' : ''}</span>
                  </span>
                  {activeProject?.id === project.id ? <span className="library-project-last-badge">上次使用</span> : null}
                  {openingProjectId === project.id
                    ? <span className="library-project-spinner is-small" aria-label="正在打开" />
                    : <span className="library-project-arrow" aria-hidden="true">›</span>}
                </button>
              ))}
            </div>
            <button
              className="library-project-gate-create"
              type="button"
              onClick={() => setCreateOpen(true)}
              disabled={openingProjectId !== null}
            >
              <span aria-hidden="true">+</span>
              新建文献项目
            </button>
          </>
        )}
      </div>

      {createOpen ? (
        <div
          className="library-project-create-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !createBusy) setCreateOpen(false)
          }}
        >
          <form className="library-project-create-dialog" role="dialog" aria-modal="true" onSubmit={createProject}>
            <div className="library-project-create-title">
              <strong>新建文献项目</strong>
              <button
                type="button"
                aria-label="关闭"
                onClick={() => setCreateOpen(false)}
                disabled={createBusy}
              >
                ×
              </button>
            </div>
            <label htmlFor="library-project-create-name">项目名称</label>
            <input
              id="library-project-create-name"
              autoFocus
              maxLength={80}
              placeholder="例如：明清史料、论文资料、待整理"
              value={createName}
              onChange={(event) => setCreateName(event.target.value)}
              disabled={createBusy}
            />
            <div className="library-project-create-actions">
              <button type="button" onClick={() => setCreateOpen(false)} disabled={createBusy}>取消</button>
              <button type="submit" className="is-primary" disabled={!createName.trim() || createBusy}>
                {createBusy ? '正在创建...' : '创建并进入'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  )
}
