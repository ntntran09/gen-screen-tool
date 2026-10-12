import { ReactFlowProvider } from '@xyflow/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Canvas } from './components/Canvas';
import { CollectionViewer } from './components/CollectionViewer';
import { Inspector } from './components/Inspector';
import { Lightbox } from './components/Lightbox';
import { Sidebar } from './components/Sidebar';
import { StatusPanel, ToastHost } from './components/StatusPanel';
import { Toolbar } from './components/Toolbar';
import { useAutosave } from './hooks/useAutosave';
import { useShortcuts } from './hooks/useShortcuts';
import { api, type ProjectSummary } from './lib/api';
import { useAssetStore } from './store/assetStore';
import { useGraphStore } from './store/graphStore';

const LAST_PROJECT_KEY = 'nodecanvas:lastProjectId';

function readLastProject(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    return null;
  }
}

function rememberProject(id: string) {
  try {
    localStorage.setItem(LAST_PROJECT_KEY, id);
  } catch {
    /* storage unavailable: just don't remember */
  }
}

function Workspace() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [fatal, setFatal] = useState<string | null>(null);
  const loadProject = useGraphStore((s) => s.loadProject);
  const save = useAutosave();
  useShortcuts(save);

  const refreshProjects = useCallback(async () => {
    const list = await api.listProjects();
    setProjects(list);
    return list;
  }, []);

  const openProject = useCallback(
    async (id: string) => {
      await save();
      const project = await api.getProject(id);
      loadProject(project);
      rememberProject(project.id);
      await useAssetStore.getState().load(project.id);
    },
    [save, loadProject],
  );

  const newProject = useCallback(async () => {
    await save();
    const project = await api.createProject('Untitled Project');
    loadProject(project);
    void useAssetStore.getState().load(project.id);
    rememberProject(project.id);
    await refreshProjects();
  }, [save, loadProject, refreshProjects]);

  // StrictMode mounts effects twice in dev; without this guard a first run would create two projects.
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    (async () => {
      try {
        const list = await refreshProjects();
        const last = readLastProject();
        const target = list.find((p) => p.id === last) ?? list[0];
        if (target) await openProject(target.id);
        else await newProject();
      } catch (err) {
        setFatal((err as Error).message);
      }
    })();
  }, [refreshProjects, openProject, newProject]);

  const rename = useCallback(
    async (name: string) => {
      const id = useGraphStore.getState().projectId;
      if (!id) return;
      try {
        await api.updateProject(id, { name });
        useGraphStore.getState().setProjectName(name);
        await refreshProjects();
      } catch (err) {
        useGraphStore.getState().showToast((err as Error).message, 'error');
      }
    },
    [refreshProjects],
  );

  if (fatal) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="max-w-md rounded-xl border border-line bg-panel p-6">
          <h1 className="text-[15px] font-semibold">Cannot start NodeCanvas</h1>
          <p className="mt-2 text-[13px] text-ink-2">{fatal}</p>
          <p className="mt-3 text-[12px] text-ink-3">Start the backend, then reload this page.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <Toolbar onSave={() => void save()} onRename={(n) => void rename(n)} />
      <div className="flex min-h-0 flex-1">
        <Sidebar
          projects={projects}
          onOpenProject={(id) => void openProject(id).catch((e: Error) => useGraphStore.getState().showToast(e.message, 'error'))}
          onNewProject={() => void newProject().catch((e: Error) => useGraphStore.getState().showToast(e.message, 'error'))}
        />
        <main className="min-w-0 flex-1">
          <Canvas />
        </main>
        <aside className="w-72 shrink-0 overflow-y-auto border-l border-line bg-panel" aria-label="Inspector">
          <Inspector />
        </aside>
      </div>
      <StatusPanel />
      <ToastHost />
      <CollectionViewer />
      <Lightbox />
    </div>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <Workspace />
    </ReactFlowProvider>
  );
}
