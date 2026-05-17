import { WorkspacesLayout } from './WorkspacesLayout';

interface WorkspacesProps {
  popout?: boolean;
}

export function Workspaces({ popout = false }: WorkspacesProps = {}) {
  return <WorkspacesLayout popout={popout} />;
}
