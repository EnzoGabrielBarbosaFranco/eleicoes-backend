import {
	ApiError,
	ELECTION_2026_SCHEDULE,
	getElectionStatus,
	getTseSettings,
	loadElectionResult,
	validateElectionParams,
} from './tse.js';
import {
	buildResultSnapshotKey,
	buildStatusSnapshotKey,
	getSnapshotNamespace,
	isFreshSnapshot,
	readSnapshot,
	withContingencyMetadata,
	writeSnapshot,
} from './snapshot.js';

const CACHE_SCHEMA_VERSION = '1';
const DEFAULT_CACHE_TTL_SECONDS = 120;
const inFlightRequests = new Map();
const ALLOWED_ORIGINS = new Set([
	'https://eleicoes-front.vercel.app',
	'http://localhost:5500',
	'http://127.0.0.1:5500',
	'http://localhost:5501',
	'http://127.0.0.1:5501',
]);

function createJsonResponse(payload, status = 200, headers = {}) {
	return new Response(JSON.stringify(payload), {
		status,
		headers: {
			'Content-Type': 'application/json;charset=UTF-8',
			...headers,
		},
	});
}

function addCorsHeaders(request, response) {
	const headers = new Headers(response.headers);
	const origin = request.headers.get('Origin');

	headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
	headers.set('Access-Control-Allow-Headers', 'Content-Type');
	headers.set(
		'Access-Control-Expose-Headers',
		'X-Status-Cache, X-TSE-Environment, X-Data-Source, X-Data-Age-Seconds, X-Snapshot-Stored-At, Retry-After, Warning',
	);
	headers.set('Vary', appendVary(headers.get('Vary'), 'Origin'));

	if (origin && ALLOWED_ORIGINS.has(origin)) {
		headers.set('Access-Control-Allow-Origin', origin);
	} else {
		headers.delete('Access-Control-Allow-Origin');
	}

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

function appendVary(currentValue, value) {
	const values = new Set(
		String(currentValue || '')
			.split(',')
			.map((item) => item.trim())
			.filter(Boolean),
	);
	values.add(value);
	return [...values].join(', ');
}

function apiErrorResponse(error) {
	if (error instanceof ApiError) {
		const retryable = ['ELEICAO_AGUARDANDO_TSE', 'DADOS_NAO_ENCONTRADOS', 'TSE_INDISPONIVEL'].includes(error.code);
		return createJsonResponse(
			{
				erro: true,
				codigo: error.code,
				mensagem: error.message,
				...(error.details && { detalhes: error.details }),
			},
			error.status,
			retryable ? { 'Retry-After': '120' } : {},
		);
	}

	console.error('Erro inesperado no Worker 2026:', error);
	return createJsonResponse(
		{
			erro: true,
			codigo: 'ERRO_INTERNO',
			mensagem: 'Ocorreu um erro interno no backend de 2026.',
		},
		500,
	);
}

async function handleElectionStatus(request, url, env, context) {
	const requestedYear = String(url.searchParams.get('ano') || '2026').trim();
	if (requestedYear !== '2026') {
		throw new ApiError(400, 'ANO_INVALIDO', 'Este backend aceita somente a eleição de 2026.');
	}

	const settings = getTseSettings(env);
	const canonicalUrl = new URL('/api/status-eleicao', url.origin);
	canonicalUrl.searchParams.set('ano', '2026');
	canonicalUrl.searchParams.set('_ambiente', settings.environment);
	canonicalUrl.searchParams.set('_schema', CACHE_SCHEMA_VERSION);

	const cachedResponse = await caches.default.match(new Request(canonicalUrl.toString()));
	if (cachedResponse) {
		const response = new Response(cachedResponse.body, cachedResponse);
		response.headers.set('X-Status-Cache', 'HIT');
		response.headers.set('X-Data-Source', edgeCacheSource(response));
		return addCorsHeaders(request, response);
	}

	const namespace = getSnapshotNamespace(env);
	const snapshotKey = buildStatusSnapshotKey(settings.environment);
	const snapshot = await safelyReadSnapshot(namespace, snapshotKey);
	const ttl = getCacheTtl(env);

	if (isFreshSnapshot(snapshot, ttl)) {
		const response = createSnapshotResponse(snapshot, env, settings.environment, false);
		context.waitUntil(storeInCache(canonicalUrl, response));
		response.headers.set('X-Status-Cache', 'MISS');
		return addCorsHeaders(request, response);
	}

	let status;
	try {
		status = await runSingleFlight(snapshotKey, () => getElectionStatus(env));
	} catch (error) {
		if (snapshot) {
			const response = createSnapshotResponse(snapshot, env, settings.environment, true, error);
			context.waitUntil(storeInCache(canonicalUrl, response));
			response.headers.set('X-Status-Cache', 'MISS');
			return addCorsHeaders(request, response);
		}
		throw error;
	}

	const response = createJsonResponse(status, 200, dataHeaders(env, settings.environment, 'tse'));
	context.waitUntil(Promise.all([storeInCache(canonicalUrl, response), safelyWriteSnapshot(namespace, snapshotKey, status)]));
	response.headers.set('X-Status-Cache', 'MISS');
	return addCorsHeaders(request, response);
}

async function handleElectionResult(request, url, env, context) {
	const params = validateElectionParams(url.searchParams);
	const settings = getTseSettings(env);
	const canonicalUrl = new URL('/api/apuracao', url.origin);
	canonicalUrl.searchParams.set('ano', params.year);
	canonicalUrl.searchParams.set('turno', params.round);
	canonicalUrl.searchParams.set('cargo', params.office);
	canonicalUrl.searchParams.set('uf', params.uf);
	canonicalUrl.searchParams.set('_ambiente', settings.environment);
	canonicalUrl.searchParams.set('_schema', CACHE_SCHEMA_VERSION);

	const cachedResponse = await caches.default.match(new Request(canonicalUrl.toString()));
	if (cachedResponse) {
		const response = new Response(cachedResponse.body, cachedResponse);
		response.headers.set('X-Status-Cache', 'HIT');
		response.headers.set('X-Data-Source', edgeCacheSource(response));
		return addCorsHeaders(request, response);
	}

	const namespace = getSnapshotNamespace(env);
	const snapshotKey = buildResultSnapshotKey(settings.environment, params);
	const snapshot = await safelyReadSnapshot(namespace, snapshotKey);
	const ttl = getCacheTtl(env);

	if (isFreshSnapshot(snapshot, ttl)) {
		const response = createSnapshotResponse(snapshot, env, settings.environment, false);
		context.waitUntil(storeInCache(canonicalUrl, response));
		response.headers.set('X-Status-Cache', 'MISS');
		return addCorsHeaders(request, response);
	}

	let result;
	try {
		result = await runSingleFlight(snapshotKey, () => loadElectionResult(params, env));
	} catch (error) {
		if (snapshot) {
			const response = createSnapshotResponse(snapshot, env, settings.environment, true, error);
			context.waitUntil(storeInCache(canonicalUrl, response));
			response.headers.set('X-Status-Cache', 'MISS');
			return addCorsHeaders(request, response);
		}
		throw error;
	}

	const response = createJsonResponse(result, 200, dataHeaders(env, settings.environment, 'tse'));
	context.waitUntil(Promise.all([storeInCache(canonicalUrl, response), safelyWriteSnapshot(namespace, snapshotKey, result)]));
	response.headers.set('X-Status-Cache', 'MISS');
	return addCorsHeaders(request, response);
}

function dataHeaders(env, environment, source, ttl = getJitteredCacheTtl(env)) {
	return {
		'Cache-Control': `public, max-age=${ttl}, s-maxage=${ttl}`,
		'X-TSE-Environment': environment,
		'X-Data-Source': source,
	};
}

function getCacheTtl(env) {
	const configured = Number.parseInt(String(env?.CACHE_TTL_SECONDS || DEFAULT_CACHE_TTL_SECONDS), 10);
	if (!Number.isFinite(configured)) {
		return DEFAULT_CACHE_TTL_SECONDS;
	}
	return Math.min(600, Math.max(30, configured));
}

function getJitteredCacheTtl(env) {
	const ttl = getCacheTtl(env);
	const variation = Math.max(1, Math.floor(ttl * 0.15));
	return ttl - variation + Math.floor(Math.random() * (variation * 2 + 1));
}

function edgeCacheSource(response) {
	return response.headers.get('Warning') ? 'edge-cache-stale' : 'edge-cache';
}

function createSnapshotResponse(snapshot, env, environment, stale, error) {
	const payload = stale
		? withContingencyMetadata(snapshot.value, snapshot, describeUpstreamError(error))
		: snapshot.value;
	const remainingTtl = stale ? 30 : Math.max(1, getCacheTtl(env) - snapshot.ageSeconds);
	const headers = {
		...dataHeaders(env, environment, stale ? 'kv-stale' : 'kv', remainingTtl),
		'X-Data-Age-Seconds': String(snapshot.ageSeconds),
		'X-Snapshot-Stored-At': snapshot.storedAt,
	};

	if (stale) {
		headers.Warning = '110 - "Resposta em contingencia: ultimo resultado oficial salvo"';
	}

	return createJsonResponse(payload, 200, headers);
}

function describeUpstreamError(error) {
	if (error instanceof ApiError) {
		return `${error.code}: ${error.message}`;
	}
	return 'O TSE esta temporariamente indisponivel.';
}

async function safelyReadSnapshot(namespace, key) {
	try {
		return await readSnapshot(namespace, key);
	} catch (error) {
		console.error('Falha ao ler o ultimo resultado salvo:', error);
		return null;
	}
}

async function safelyWriteSnapshot(namespace, key, value) {
	try {
		await writeSnapshot(namespace, key, value);
	} catch (error) {
		console.error('Falha ao salvar o ultimo resultado valido:', error);
	}
}

async function runSingleFlight(key, operation) {
	const existing = inFlightRequests.get(key);
	if (existing) {
		return existing;
	}

	const pending = operation().finally(() => inFlightRequests.delete(key));
	inFlightRequests.set(key, pending);
	return pending;
}

async function storeInCache(canonicalUrl, response) {
	try {
		await caches.default.put(new Request(canonicalUrl.toString()), response.clone());
	} catch (error) {
		console.error('Falha ao gravar resposta no cache:', error);
	}
}

export default {
	async fetch(request, env, context) {
		if (request.method === 'OPTIONS') {
			return addCorsHeaders(request, new Response(null, { status: 204 }));
		}

		if (!['GET', 'HEAD'].includes(request.method)) {
			return addCorsHeaders(
				request,
				createJsonResponse(
					{
						erro: true,
						codigo: 'METODO_NAO_PERMITIDO',
						mensagem: 'Utilize o método GET para consultar esta API.',
					},
					405,
					{ Allow: 'GET, HEAD, OPTIONS' },
				),
			);
		}

		const url = new URL(request.url);

		try {
			const settings = getTseSettings(env);

			if (url.pathname === '/') {
				return addCorsHeaders(
					request,
					createJsonResponse({
						status: 'online',
						servico: 'API Eleições 2026',
						anoPadrao: 2026,
						anoEleicaoAtual: 2026,
						ambienteTse: settings.environment,
						endpoints: {
							apuracao: '/api/apuracao?ano=2026&turno=1&cargo=1&uf=br',
							statusEleicao: '/api/status-eleicao?ano=2026',
							calendario: '/api/calendario',
						},
						cache: `${getCacheTtl(env)} segundos`,
					}),
				);
			}

			if (url.pathname === '/api/status-eleicao') {
				return await handleElectionStatus(request, url, env, context);
			}

			if (url.pathname === '/api/apuracao') {
				return await handleElectionResult(request, url, env, context);
			}

			if (url.pathname === '/api/calendario') {
				return addCorsHeaders(
					request,
					createJsonResponse(
						{ ano: 2026, ...ELECTION_2026_SCHEDULE },
						200,
						{ 'Cache-Control': 'public, max-age=86400, s-maxage=86400' },
					),
				);
			}

			return addCorsHeaders(
				request,
				createJsonResponse(
					{
						erro: true,
						codigo: 'CAMINHO_INVALIDO',
						mensagem: 'Caminho inválido.',
					},
					404,
				),
			);
		} catch (error) {
			return addCorsHeaders(request, apiErrorResponse(error));
		}
	},
};
