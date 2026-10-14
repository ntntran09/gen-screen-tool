import type { OutputData } from '../graph/types';
import { formatDuration, useBatchTime } from '../hooks/useBatchTime';
import { isRunning, OPEN_STATUSES, useGenerationStore } from '../store/generationStore';
import { AssetThumb } from './AssetThumb';
import { FailureReasons } from './FailureReasons';
import { MunLoader } from './MunLoader';

/** The saved action survives reloads, renames and collaboration updates. */
export function OutputPlaceholder({ data }: { data: OutputData }) {
  const batch = useGenerationStore((s) => data.generationId ? s.batches[data.generationId] : undefined);
  const starting = useGenerationStore((s) => !!(data.sourceNodeId && s.starting[data.sourceNodeId]));
  const time = useBatchTime(data.generationId);
  const action = data.resultAction ?? (data.pendingSlot !== undefined ? 'retry' : data.title === 'Varied result' ? 'variation' : undefined);
  if (!action) return <AssetThumb assetId={null} emptyLabel="Waiting for a generation" />;
  const live = starting || isRunning(batch);
  const cancellable = batch && OPEN_STATUSES.includes(batch.status) && !batch.cancel_requested;
  return (
    <div>
      <MunLoader variant={action === 'retry' ? 'erasing' : 'placing'} label={null} playing={live} />
      {!live && batch && batch.failed_count > 0 && <div className="mt-1.5"><FailureReasons batchId={batch.id} max={1} /></div>}
      {(live || cancellable) && (
        <p role="status" className="mt-1.5 flex items-center justify-center gap-2 text-[11px] text-ink-2">
          <span className="font-mono tabular-nums" title="Time spent generating this image">
            ⏱ {formatDuration(time?.ms ?? 0)}
          </span>
          {cancellable && (
            <button type="button" className="nodrag rounded px-1 font-medium underline-offset-2 hover:text-ink hover:underline"
              title="Stops it if it has not been sent yet. A request already sent cannot be stopped."
              onClick={() => void useGenerationStore.getState().cancel(batch.id)}>
              Cancel
            </button>
          )}
        </p>
      )}
    </div>
  );
}
