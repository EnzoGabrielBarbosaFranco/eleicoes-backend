import { ApiError, fetchElectionCatalog, getElectionStatus, loadElectionResult } from './tse.js';
import {
	getConfiguredFeeds,
	readResultSnapshot,
	writeCollectorStatus,
	writeElectionStatusSnapshot,
	writeResultSnapshot,
} from './snapshots.js';

const DEFAULT_MAX_TSE_REQUESTS_PER_SECOND = 5;

export async function refreshElectionData(env, dependencies = {}) {
	const startedAt = new Date().toISOString();
	const feeds = getConfiguredFeeds(env);
	const loadCatalog = dependencies.fetchElectionCatalog || fetchElectionCatalog;
	const loadStatus = dependencies.getElectionStatus || getElectionStatus;
	const loadResult = dependencies.loadElectionResult || loadElectionResult;
	const wait = dependencies.wait || waitSafely;
	const intervalMs = requestIntervalMs(env);
	const results = [];
	let catalog = null;
	let catalogError = null;

	try {
		catalog = await loadCatalog();
		const electionStatus = await loadStatus('2026', { catalog });
		await writeElectionStatusSnapshot(env, '2026', electionStatus);
	} catch (error) {
		catalogError = serializeError(error);
		console.error('Coletor nao conseguiu atualizar o catalogo do TSE:', error);
	}

	for (const params of feeds) {
		try {
			if (params.year === '2022' && (await readResultSnapshot(env, params))) {
				results.push({ feed: params, status: 'historico_preservado' });
				continue;
			}

			if (params.year === '2026' && !catalog) {
				results.push({ feed: params, status: 'falha', erro: catalogError });
				continue;
			}

			await wait(intervalMs);
			const source = await loadResult(params, params.year === '2026' ? { catalog } : {});
			const stored = await writeResultSnapshot(env, params, source);
			results.push({
				feed: params,
				status: stored?.changed ? 'atualizado' : 'sem_alteracao',
				idGeracao: source.payload.idGeracao ?? null,
			});
		} catch (error) {
			const serialized = serializeError(error);
			const waitingForTse = error instanceof ApiError && ['ELEICAO_AGUARDANDO_TSE', 'DADOS_NAO_ENCONTRADOS'].includes(error.code);
			results.push({
				feed: params,
				status: waitingForTse ? 'aguardando_tse' : 'falha',
				erro: serialized,
			});

			if (!waitingForTse) {
				console.error('Falha ao atualizar feed eleitoral:', params, error);
			}
		}
	}

	const status = {
		startedAt,
		finishedAt: new Date().toISOString(),
		feedsConfigurados: feeds.length,
		catalogo: catalog ? 'atualizado' : 'falha',
		...(catalogError && { erroCatalogo: catalogError }),
		resultados: results,
	};

	await writeCollectorStatus(env, status);
	return status;
}

function requestIntervalMs(env) {
	const configuredRate = Number.parseInt(String(env?.TSE_MAX_REQUESTS_PER_SECOND || ''), 10);
	const requestsPerSecond = Number.isFinite(configuredRate)
		? Math.min(Math.max(configuredRate, 1), 10)
		: DEFAULT_MAX_TSE_REQUESTS_PER_SECOND;
	return Math.ceil(1000 / requestsPerSecond);
}

async function waitSafely(delay) {
	if (globalThis.scheduler?.wait) {
		await globalThis.scheduler.wait(delay);
		return;
	}

	await new Promise((resolve) => setTimeout(resolve, delay));
}

function serializeError(error) {
	return {
		codigo: error instanceof ApiError ? error.code : 'ERRO_COLETOR',
		mensagem: error instanceof Error ? error.message : String(error),
	};
}
