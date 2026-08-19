import { validateElectionParams } from './tse.js';

const SNAPSHOT_SCHEMA_VERSION = 1;
const DEFAULT_FEEDS = [
	{ ano: 2022, turno: 1, cargo: 1, uf: 'br' },
	{ ano: 2026, turno: 1, cargo: 1, uf: 'br' },
];

export function hasSnapshotStore(env) {
	return Boolean(env?.ELECTION_DATA);
}

export function getConfiguredFeeds(env) {
	const configured = parseConfiguredFeeds(env?.ELECTION_FEEDS);
	const feeds = configured.length > 0 ? configured : DEFAULT_FEEDS;
	const unique = new Map();

	for (const feed of feeds.slice(0, 200)) {
		const params = validateElectionParams(
			new URLSearchParams({
				ano: String(feed.ano ?? feed.year ?? ''),
				turno: String(feed.turno ?? feed.round ?? '1'),
				cargo: String(feed.cargo ?? feed.office ?? '1'),
				uf: String(feed.uf ?? 'br'),
			}),
		);
		unique.set(feedId(params), params);
	}

	return [...unique.values()];
}

function parseConfiguredFeeds(value) {
	if (Array.isArray(value)) {
		return value;
	}

	if (typeof value !== 'string' || !value.trim()) {
		return [];
	}

	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : [];
	} catch (error) {
		console.error('ELECTION_FEEDS possui JSON invalido:', error);
		return [];
	}
}

export function feedId(params) {
	return `${params.year}-${params.round}-${params.office}-${params.uf}`;
}

export function resultSnapshotKey(params) {
	return `snapshots/resultados/${params.year}/${params.round}/${params.office}/${params.uf}/latest.json`;
}

export function publicResultKey(params) {
	return `public/resultados/${params.year}/${params.round}/${params.office}/${params.uf}.json`;
}

export async function readResultSnapshot(env, params) {
	return readJson(env, resultSnapshotKey(params));
}

export async function writeResultSnapshot(env, params, source, collectedAt = new Date().toISOString()) {
	if (!hasSnapshotStore(env)) {
		return null;
	}

	const version = String(source.payload.idGeracao ?? source.payload.atualizacao ?? collectedAt);
	const envelope = {
		schemaVersion: SNAPSHOT_SCHEMA_VERSION,
		feed: params,
		collectedAt,
		version,
		sourceUrl: source.sourceUrl,
		data: source.payload,
	};
	const previous = await readResultSnapshot(env, params);
	const changed = previous?.version !== version;

	await env.ELECTION_DATA.put(resultSnapshotKey(params), JSON.stringify(envelope), {
		httpMetadata: jsonMetadata('public, max-age=30, stale-if-error=86400'),
		customMetadata: {
			collectedAt,
			version,
			feed: feedId(params),
		},
	});

	if (changed) {
		await Promise.all([
			env.ELECTION_DATA.put(publicResultKey(params), JSON.stringify(source.payload), {
				httpMetadata: jsonMetadata('public, max-age=15, stale-if-error=86400'),
				customMetadata: { collectedAt, version, source: 'TSE' },
			}),
			env.ELECTION_DATA.put(
				`raw/resultados/${params.year}/${params.round}/${params.office}/${params.uf}/${safeKey(version)}.json`,
				JSON.stringify(source.raw),
				{
					httpMetadata: jsonMetadata('private, max-age=0'),
					customMetadata: { collectedAt, version, sourceUrl: source.sourceUrl },
				},
			),
		]);
	}

	return { envelope, changed };
}

export async function readElectionStatusSnapshot(env, year) {
	return readJson(env, `snapshots/status/${year}.json`);
}

export async function writeElectionStatusSnapshot(env, year, data, collectedAt = new Date().toISOString()) {
	if (!hasSnapshotStore(env)) {
		return null;
	}

	const envelope = {
		schemaVersion: SNAPSHOT_SCHEMA_VERSION,
		collectedAt,
		data,
	};

	await Promise.all([
		env.ELECTION_DATA.put(`snapshots/status/${year}.json`, JSON.stringify(envelope), {
			httpMetadata: jsonMetadata('public, max-age=60, stale-if-error=86400'),
			customMetadata: { collectedAt, year: String(year) },
		}),
		env.ELECTION_DATA.put(`public/status/${year}.json`, JSON.stringify(data), {
			httpMetadata: jsonMetadata('public, max-age=30, stale-if-error=86400'),
			customMetadata: { collectedAt, year: String(year), source: 'TSE' },
		}),
	]);

	return envelope;
}

export async function readCollectorStatus(env) {
	return readJson(env, 'system/collector-status.json');
}

export async function writeCollectorStatus(env, status) {
	if (!hasSnapshotStore(env)) {
		return null;
	}

	await env.ELECTION_DATA.put('system/collector-status.json', JSON.stringify(status), {
		httpMetadata: jsonMetadata('no-store'),
		customMetadata: { finishedAt: status.finishedAt || new Date().toISOString() },
	});
	return status;
}

async function readJson(env, key) {
	if (!hasSnapshotStore(env)) {
		return null;
	}

	const object = await env.ELECTION_DATA.get(key);
	if (!object?.body) {
		return null;
	}

	try {
		return await object.json();
	} catch (error) {
		console.error(`Snapshot invalido no R2 (${key}):`, error);
		return null;
	}
}

function jsonMetadata(cacheControl) {
	return {
		contentType: 'application/json;charset=UTF-8',
		cacheControl,
	};
}

function safeKey(value) {
	return String(value).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}
