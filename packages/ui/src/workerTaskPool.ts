/**
 * Shared bounded pool for render-thread offload workers, following the
 * readingWorkerPool shape: at most `limit` workers, idle ones are disposed after
 * `idleMs`, every job has a hard `timeoutMs` (a wedged worker is terminated and
 * the fallback answers), and the queue is capped so a burst of mounts cannot
 * pile up — the oldest queued jobs answer with the fallback instead. Cancelling
 * a running job terminates its worker; worker construction failures, errors and
 * timeouts all answer through `fallback`, so every caller keeps a usable
 * (main-thread) result and no error or cancel semantics are lost.
 */
export interface WorkerTaskPoolOptions<I, O> {
	create(): Worker;
	/** Main-thread answer when the worker cannot run (no Worker, error, timeout). */
	fallback(input: I): O;
	/** Concurrent workers; two keeps big scans parallel without extra heaps. */
	limit?: number;
	/** Idle workers are terminated after this long. */
	idleMs?: number;
	/** Per-job wall clock; beyond it the worker is disposed and the fallback answers. */
	timeoutMs: number;
	/** Queued jobs beyond this answer with the fallback immediately. */
	queueLimit?: number;
}

interface Job<I, O> { input: I; done(value: O): void; cancelled: boolean }

export interface WorkerTaskPool<I, O> {
	request(input: I, done: (value: O) => void): () => void;
}

export function createWorkerTaskPool<I, O>(options: WorkerTaskPoolOptions<I, O>): WorkerTaskPool<I, O> {
	const limit = options.limit ?? 2;
	const idleMs = options.idleMs ?? 5_000;
	const queueLimit = options.queueLimit ?? 32;
	const queue: Job<I, O>[] = [];
	const slots = new Set<{ worker: Worker; job: Job<I, O> | null; timer?: ReturnType<typeof setTimeout> }>();
	const dispose = (slot: { worker: Worker; job: Job<I, O> | null; timer?: ReturnType<typeof setTimeout> }) => {
		clearTimeout(slot.timer);
		slot.worker.terminate();
		slots.delete(slot);
	};
	const answer = (job: Job<I, O> | null) => { if (job && !job.cancelled) job.done(options.fallback(job.input)); };
	const pump = () => {
		while (queue.length) {
			let slot = [...slots].find((value) => !value.job);
			if (!slot) {
				if (slots.size >= limit) return;
				try {
					slot = { worker: options.create(), job: null };
					slots.add(slot);
					const currentSlot = slot;
					slot.worker.onmessage = (event: MessageEvent<O>) => {
						if (!slots.has(currentSlot)) return;
						clearTimeout(currentSlot.timer);
						const job = currentSlot.job;
						currentSlot.job = null;
						if (job && !job.cancelled) job.done(event.data);
						currentSlot.timer = setTimeout(() => dispose(currentSlot), idleMs);
						pump();
					};
					slot.worker.onerror = () => {
						if (!slots.has(currentSlot)) return;
						const job = currentSlot.job;
						currentSlot.job = null;
						dispose(currentSlot);
						answer(job);
						pump();
					};
				} catch {
					// Construction failed (broken build or no worker support): answer
					// everything pending on the main thread and let the next call retry.
					for (const pending of queue.splice(0)) answer(pending);
					return;
				}
			}
			const job = queue.shift()!;
			if (job.cancelled) continue;
			clearTimeout(slot.timer);
			slot.job = job;
			slot.timer = setTimeout(() => { dispose(slot); answer(job); pump(); }, options.timeoutMs);
			try { slot.worker.postMessage(job.input); } catch { dispose(slot); answer(job); }
		}
	};
	return {
		request(input, done) {
			const job: Job<I, O> = { input, done, cancelled: false };
			while (queue.length >= queueLimit) answer(queue.shift()!);
			queue.push(job);
			pump();
			return () => {
				job.cancelled = true;
				const index = queue.indexOf(job);
				if (index >= 0) queue.splice(index, 1);
				for (const slot of slots) if (slot.job === job) { dispose(slot); break; }
				pump();
			};
		},
	};
}
