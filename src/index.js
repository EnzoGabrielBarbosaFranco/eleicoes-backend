import { refreshElectionData } from './collector.js';
import {
	readCollectorStatus,
	readElectionStatusSnapshot,
	readResultSnapshot,
	writeElectionStatusSnapshot,
	writeResultSnapshot,
} from './snapshots.js';
import { ApiError, getElectionStatus, loadElectionResult, validateElectionParams } from './tse.js';

const CACHE_TTL_SECONDS = 30;
const CACHE_SCHEMA_VERSION = '4';
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
		'X-Status-Cache, X-Data-Source, X-Data-Collected-At, X-Data-Stale, Retry-After',
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
		return createJsonResponse(
			{
				erro: true,
				codigo: error.code,
				mensagem: error.message,
				...(error.details && { detalhes: error.details }),
			},
			error.status,
			error.code === 'DADOS_AQUECENDO' ? { 'Retry-After': '120' } : {},
		);
	}

	console.error('Erro inesperado no Worker:', error);
	return createJsonResponse(
		{
			erro: true,
			codigo: 'ERRO_INTERNO',
			mensagem: 'Ocorreu um erro interno no backend.',
		},
		500,
	);
}

async function handleElectionStatus(url, env, context) {
	const year = String(url.searchParams.get('ano') || '2022').trim();
	const canonicalUrl = new URL('/api/status-eleicao', url.origin);
	canonicalUrl.searchParams.set('ano', year);
	canonicalUrl.searchParams.set('_schema', CACHE_SCHEMA_VERSION);

	const cache = caches.default;
	const cacheKey = new Request(canonicalUrl.toString(), { method: 'GET' });
	const cachedResponse = await cache.match(cacheKey);

	if (cachedResponse) {
		const response = new Response(cachedResponse.body, cachedResponse);
		response.headers.set('X-Status-Cache', 'HIT');
		return response;
	}

	let snapshot = null;
	try {
		snapshot = await readElectionStatusSnapshot(env, year);
	} catch (error) {
		console.error('Falha ao ler status persistente:', error);
	}

	let status;
	let source = 'TSE';
	if (snapshot?.data) {
		status = snapshot.data;
		source = 'R2';
	} else {
		if (year === '2026' && !allowOnDemandTseFetch(env)) {
			throw new ApiError(503, 'DADOS_AQUECENDO', 'A coleta de 2026 ainda nao possui um snapshot disponivel.');
		}

		status = await getElectionStatus(year);
		context.waitUntil(
			writeElectionStatusSnapshot(env, year, status).catch((error) => {
				console.error('Falha ao persistir status eleitoral:', error);
			}),
		);
	}

	const response = createJsonResponse(status, 200, {
		'Cache-Control': 'public, max-age=30, s-maxage=60, stale-if-error=86400',
		'X-Data-Source': source,
		...(snapshot?.collectedAt && snapshotMetadataHeaders(snapshot)),
	});

	context.waitUntil(
		cache.put(cacheKey, response.clone()).catch((error) => {
			console.error('Falha ao gravar status no cache:', error);
		}),
	);

	response.headers.set('X-Status-Cache', 'MISS');
	return response;
}

async function handleElectionResult(request, url, env, context) {
	const params = validateElectionParams(url.searchParams);
	const canonicalUrl = new URL('/api/apuracao', url.origin);
	canonicalUrl.searchParams.set('ano', params.year);
	canonicalUrl.searchParams.set('turno', params.round);
	canonicalUrl.searchParams.set('cargo', params.office);
	canonicalUrl.searchParams.set('uf', params.uf);
	canonicalUrl.searchParams.set('_schema', CACHE_SCHEMA_VERSION);

	const cache = caches.default;
	const cacheKey = new Request(canonicalUrl.toString(), { method: 'GET' });
	const cachedResponse = await cache.match(cacheKey);

	if (cachedResponse) {
		const response = new Response(cachedResponse.body, cachedResponse);
		response.headers.set('X-Status-Cache', 'HIT');
		return addCorsHeaders(request, response);
	}

	let snapshot = null;
	try {
		snapshot = await readResultSnapshot(env, params);
	} catch (error) {
		console.error('Falha ao ler resultado persistente:', error);
	}

	let result;
	let source = 'TSE';
	if (snapshot?.data) {
		result = snapshot.data;
		source = 'R2';
	} else {
		if (!allowOnDemandTseFetch(env)) {
			throw new ApiError(503, 'DADOS_AQUECENDO', 'Este resultado ainda nao foi coletado. Tente novamente em alguns minutos.');
		}

		const loaded = await loadElectionResult(params);
		result = loaded.payload;
		context.waitUntil(
			writeResultSnapshot(env, params, loaded).catch((error) => {
				console.error('Falha ao persistir resultado eleitoral:', error);
			}),
		);
	}

	const response = createJsonResponse(result, 200, {
		'Cache-Control': `public, max-age=15, s-maxage=${CACHE_TTL_SECONDS}, stale-if-error=86400`,
		'X-Data-Source': source,
		...(snapshot?.collectedAt && snapshotMetadataHeaders(snapshot, params.year)),
	});

	context.waitUntil(
		cache.put(cacheKey, response.clone()).catch((error) => {
			console.error('Falha ao gravar resposta no cache:', error);
		}),
	);

	response.headers.set('X-Status-Cache', 'MISS');
	return addCorsHeaders(request, response);
}

function allowOnDemandTseFetch(env) {
	return String(env?.ALLOW_ON_DEMAND_TSE_FETCH ?? 'true').toLowerCase() !== 'false';
}

function snapshotMetadataHeaders(snapshot, year = '2026') {
	const collectedAt = snapshot.collectedAt;
	const ageMs = Math.max(0, Date.now() - new Date(collectedAt).getTime());
	const stale = year !== '2022' && ageMs > 5 * 60 * 1000;
	return {
		'X-Data-Collected-At': collectedAt,
		'X-Data-Stale': String(stale),
	};
}

async function handleHealth(env) {
	const collector = await readCollectorStatus(env);
	return createJsonResponse(
		{
			status: collector ? 'online' : 'aguardando_primeira_coleta',
			armazenamentoPersistente: Boolean(env?.ELECTION_DATA),
			coletor: collector,
		},
		collector ? 200 : 503,
		{ 'Cache-Control': 'no-store' },
	);
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
			if (url.pathname === '/') {
				return addCorsHeaders(
					request,
					createJsonResponse({
						status: 'online',
						servico: 'API Eleições',
						anoPadrao: 2022,
						anoEleicaoAtual: 2026,
						endpoints: {
							apuracaoAmostra: '/api/apuracao?ano=2022&turno=1&cargo=1&uf=br',
							statusEleicaoAtual: '/api/status-eleicao?ano=2026',
							saude: '/api/saude',
						},
						cache: 'edge + snapshot persistente',
						coleta: 'agendada a cada 2 minutos',
					}),
				);
			}

			if (url.pathname === '/api/status-eleicao') {
				return addCorsHeaders(request, await handleElectionStatus(url, env, context));
			}

			if (url.pathname === '/api/apuracao') {
				return await handleElectionResult(request, url, env, context);
			}

			if (url.pathname === '/api/saude') {
				return addCorsHeaders(request, await handleHealth(env));
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

	async scheduled(controller, env, context) {
		context.waitUntil(
			refreshElectionData(env).catch((error) => {
				console.error('Falha geral no coletor agendado:', error);
				throw error;
			}),
		);
	},
};
