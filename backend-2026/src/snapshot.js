const SNAPSHOT_SCHEMA_VERSION = '1';
const KV_READ_CACHE_TTL_SECONDS = 60;

export function getSnapshotNamespace(env = {}) {
	const namespace = env.ELECTION_RESULTS_KV;
	if (!namespace || typeof namespace.getWithMetadata !== 'function' || typeof namespace.put !== 'function') {
		return null;
	}
	return namespace;
}

export function buildStatusSnapshotKey(environment) {
	return `eleicoes:${SNAPSHOT_SCHEMA_VERSION}:${environment}:status:2026`;
}

export function buildResultSnapshotKey(environment, params) {
	return `eleicoes:${SNAPSHOT_SCHEMA_VERSION}:${environment}:apuracao:${params.year}:${params.round}:${params.office}:${params.uf}`;
}

export async function readSnapshot(namespace, key, now = Date.now()) {
	if (!namespace) {
		return null;
	}

	const stored = await namespace.getWithMetadata(key, {
		type: 'json',
		cacheTtl: KV_READ_CACHE_TTL_SECONDS,
	});

	if (!stored?.value || !stored.metadata?.storedAt) {
		return null;
	}

	const storedAtMs = Date.parse(stored.metadata.storedAt);
	if (!Number.isFinite(storedAtMs)) {
		return null;
	}

	return {
		value: stored.value,
		storedAt: stored.metadata.storedAt,
		ageSeconds: Math.max(0, Math.floor((now - storedAtMs) / 1000)),
	};
}

export async function writeSnapshot(namespace, key, value, now = Date.now()) {
	if (!namespace) {
		return;
	}

	const storedAt = new Date(now).toISOString();
	await namespace.put(key, JSON.stringify(value), {
		metadata: {
			storedAt,
			idGeracao: value?.idGeracao == null ? null : String(value.idGeracao),
		},
	});
}

export function isFreshSnapshot(snapshot, ttlSeconds) {
	return Boolean(snapshot && snapshot.ageSeconds <= ttlSeconds);
}

export function withContingencyMetadata(value, snapshot, reason) {
	return {
		...value,
		contingencia: {
			ativa: true,
			motivo: reason,
			ultimoResultadoSalvoEm: snapshot.storedAt,
			idadeSegundos: snapshot.ageSeconds,
		},
	};
}
