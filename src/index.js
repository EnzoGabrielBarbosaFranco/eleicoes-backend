import { ApiError, getElectionResult, getElectionStatus, getHistoricalElectionResult, validateElectionParams } from './tse.js';

const CACHE_TTL_SECONDS = 120;
const CACHE_SCHEMA_VERSION = '3';
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
	headers.set('Access-Control-Expose-Headers', 'X-Status-Cache, X-Data-Source');
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

async function handleElectionStatus(url, context) {
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

	const status = await getElectionStatus(year);
	const response = createJsonResponse(status, 200, {
		'Cache-Control': 'public, max-age=300, s-maxage=300',
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

	const historical = params.year === '2022';
	const result = historical ? await getHistoricalElectionResult(params, env) : await getElectionResult(params);
	const ttl = historical ? 86400 : CACHE_TTL_SECONDS;
	const response = createJsonResponse(result, 200, {
		'Cache-Control': `public, max-age=${ttl}, s-maxage=${ttl}`,
		'X-Data-Source': historical ? 'kv-history' : 'tse',
	});

	context.waitUntil(
		cache.put(cacheKey, response.clone()).catch((error) => {
			console.error('Falha ao gravar resposta no cache:', error);
		}),
	);

	response.headers.set('X-Status-Cache', 'MISS');
	return addCorsHeaders(request, response);
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
						},
						cache: 'ativado',
					}),
				);
			}

			if (url.pathname === '/api/status-eleicao') {
				return addCorsHeaders(request, await handleElectionStatus(url, context));
			}

			if (url.pathname === '/api/apuracao') {
				return await handleElectionResult(request, url, env, context);
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
