/**
 * One modal for everything the user must know or decide: missing access, a
 * refresh that failed, a confirmation before a change. It opens over the screen
 * that is already drawn, so no check ever holds the screen back.
 *
 * It is the native <dialog>: `window.alert`, `confirm` and `prompt` do nothing
 * in the app frame, whose sandbox does not allow modals.
 */
import { useEffect, useRef } from 'react';

export interface Notice {
  title: string;
  message: string;
  /** A second button, for example "Retry" or "Delete". */
  actionLabel?: string;
  onAction?: () => void;
}

export function NoticeDialog({ notice, onClose }: { notice?: Notice; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (notice && !dialog.open) dialog.showModal();
    if (!notice && dialog.open) dialog.close();
  }, [notice]);

  return (
    <dialog ref={ref} onClose={onClose} style={{ maxWidth: 420, borderRadius: 8, border: '1px solid #8884', fontFamily: 'system-ui' }}>
      {notice && (
        <>
          <h3 style={{ marginTop: 0 }}>{notice.title}</h3>
          <p>{notice.message}</p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" onClick={onClose}>
              Close
            </button>
            {notice.actionLabel && notice.onAction && (
              <button
                type="button"
                onClick={() => {
                  // Close first, so a notice the action raises is not closed with this one.
                  onClose();
                  notice.onAction?.();
                }}
              >
                {notice.actionLabel}
              </button>
            )}
          </div>
        </>
      )}
    </dialog>
  );
}
