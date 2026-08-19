export const TSE_RESULTS_BASE_URL = 'https://resultados.tse.jus.br';
export const TSE_ELECTION_CATALOG_URL = `${TSE_RESULTS_BASE_URL}/oficial/comum/config/ele-c.json`;
export const TSE_CANDIDATES_2026_URL = 'https://dadosabertos.tse.jus.br/dataset/candidatos-2026';

const VALID_YEARS = new Set(['2022', '2026']);
const VALID_ROUNDS = new Set(['1', '2']);
const VALID_OFFICES = new Set(['1', '3', '5', '6', '7', '8']);
const VALID_UFS = new Set([
	'ac',
	'al',
	'ap',
	'am',
	'ba',
	'ce',
	'df',
	'es',
	'go',
	'ma',
	'mt',
	'ms',
	'mg',
	'pa',
	'pb',
	'pr',
	'pe',
	'pi',
	'rj',
	'rn',
	'rs',
	'ro',
	'rr',
	'sc',
	'sp',
	'se',
	'to',
]);

const ELECTED_STATUSES = new Set(['eleito', 'eleito por qp', 'eleito por média']);

const LEGACY_ELECTIONS_2022 = {
	'1': { '1': '544', '2': '545' },
	estadual: { '1': '546', '2': '547' },
};

export class ApiError extends Error {
	constructor(status, code, message, details) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.code = code;
		this.details = details;
	}
}

export function validateElectionParams(searchParams) {
	const year = String(searchParams.get('ano') || '2022').trim();
	const round = String(searchParams.get('turno') || '1').trim();
	const office = String(searchParams.get('cargo') || '1').trim();
	const uf = String(searchParams.get('uf') || 'br').trim().toLowerCase();

	if (!VALID_YEARS.has(year)) {
		throw new ApiError(400, 'ANO_INVALIDO', 'O ano deve ser 2022 ou 2026.');
	}

	if (!VALID_ROUNDS.has(round)) {
		throw new ApiError(400, 'TURNO_INVALIDO', 'O turno deve ser 1 ou 2.');
	}

	if (!VALID_OFFICES.has(office)) {
		throw new ApiError(400, 'CARGO_INVALIDO', 'O cargo deve ser 1, 3, 5, 6, 7 ou 8.');
	}

	if (uf !== 'br' && !VALID_UFS.has(uf)) {
		throw new ApiError(400, 'UF_INVALIDA', 'Informe br ou uma sigla de UF válida.');
	}

	if (office !== '1' && uf === 'br') {
		throw new ApiError(400, 'UF_OBRIGATORIA', 'Selecione uma UF para este cargo.');
	}

	if (round === '2' && !['1', '3'].includes(office)) {
		throw new ApiError(400, 'SEM_SEGUNDO_TURNO', 'Este cargo não possui segundo turno.');
	}

	if (office === '7' && uf === 'df') {
		throw new ApiError(400, 'CARGO_DISTRITAL', 'No Distrito Federal, use o cargo 8 para deputado distrital.');
	}

	if (office === '8' && uf !== 'df') {
		throw new ApiError(400, 'CARGO_DISTRITAL', 'O cargo 8 é exclusivo para deputado distrital no DF.');
	}

	return { year, round, office, uf };
}

export function findElectionInCatalog(catalog, params) {
	const expectedElectionType = params.office === '1' ? '8' : '1';
	const expectedCycle = `ele${params.year}`;

	for (const electionEvent of catalog.pl || []) {
		const eventYear = String(electionEvent.dt || '').slice(-4);
		const cycle = String(electionEvent.c || (eventYear === params.year ? expectedCycle : catalog.c) || '').toLowerCase();

		if (cycle !== expectedCycle && eventYear !== params.year) {
			continue;
		}

		for (const election of electionEvent.e || []) {
			if (String(election.t) !== params.round || String(election.tp) !== expectedElectionType) {
				continue;
			}

			const scopes = election.abr || [];
			const scope =
				scopes.find((item) => String(item.cd).toLowerCase() === params.uf) ||
				scopes.find((item) => String(item.cd).toLowerCase() === 'br');
			const hasOffice = scope?.cp?.some((item) => String(item.cd) === params.office);

			if (!scope || !hasOffice) {
				continue;
			}

			return {
				cycle: cycle || expectedCycle,
				electionCode: String(election.cd),
				electionSequence: election.sqele ? String(election.sqele) : null,
				electionName: decodeHtmlEntities(election.nm || ''),
				electionDate: electionEvent.dt || null,
				pleitoCode: String(electionEvent.cd),
			};
		}
	}

	return null;
}

export function buildUnifiedResultUrl(selection, params, environment = 'oficial') {
	const electionCode = selection.electionCode.padStart(6, '0');
	const officeCode = params.office.padStart(4, '0');
	return `${TSE_RESULTS_BASE_URL}/${environment}/${selection.cycle}/${selection.electionCode}/dados/${params.uf}/${params.uf}-c${officeCode}-e${electionCode}-u.json`;
}

function buildLegacyResultUrl(params) {
	const electionCode = params.office === '1' ? LEGACY_ELECTIONS_2022['1'][params.round] : LEGACY_ELECTIONS_2022.estadual[params.round];
	const officeCode = params.office.padStart(4, '0');
	return {
		electionCode,
		url: `${TSE_RESULTS_BASE_URL}/oficial/ele2022/${electionCode}/dados-simplificados/${params.uf}/${params.uf}-c${officeCode}-e${electionCode.padStart(6, '0')}-r.json`,
	};
}

async function fetchTseJson(url) {
	let response;

	try {
		response = await fetch(url, {
			headers: {
				Accept: 'application/json',
				'User-Agent': 'Mozilla/5.0 (compatible; backend-eleicoes/1.0)',
			},
			signal: AbortSignal.timeout(10_000),
		});
	} catch (error) {
		throw new ApiError(502, 'TSE_INDISPONIVEL', 'Não foi possível conectar ao TSE.', {
			cause: error instanceof Error ? error.message : String(error),
		});
	}

	if (response.status === 404) {
		throw new ApiError(404, 'DADOS_NAO_ENCONTRADOS', 'O TSE ainda não disponibilizou os dados desta consulta.');
	}

	if (!response.ok) {
		response.body?.cancel();
		throw new ApiError(502, 'RESPOSTA_TSE_INVALIDA', `O TSE respondeu com o status ${response.status}.`);
	}

	try {
		return await response.json();
	} catch {
		throw new ApiError(502, 'JSON_TSE_INVALIDO', 'O TSE retornou dados em um formato inválido.');
	}
}

export async function fetchElectionCatalog() {
	return fetchTseJson(TSE_ELECTION_CATALOG_URL);
}

export async function getElectionStatus(year = '2022', options = {}) {
	if (!VALID_YEARS.has(String(year))) {
		throw new ApiError(400, 'ANO_INVALIDO', 'O ano deve ser 2022 ou 2026.');
	}

	if (String(year) === '2022') {
		return {
			ano: 2022,
			resultadosDisponiveis: true,
			fase: 'historico',
			ciclo: 'ele2022',
			candidatos: { publicadosPeloTse: true, disponiveisNaApi: true, fonte: 'TSE' },
		};
	}

	const catalog = options.catalog || (await fetchElectionCatalog());
	const elections = [];

	for (const electionEvent of catalog.pl || []) {
		const eventYear = String(electionEvent.dt || '').slice(-4);
		const cycle = String(electionEvent.c || (eventYear === String(year) ? `ele${year}` : catalog.c) || '').toLowerCase();

		if (cycle !== `ele${year}` && eventYear !== String(year)) {
			continue;
		}

		for (const election of electionEvent.e || []) {
			if (!['1', '8'].includes(String(election.tp))) {
				continue;
			}

			elections.push({
				codigo: String(election.cd),
				nome: decodeHtmlEntities(election.nm || ''),
				turno: Number(election.t),
				tipo: String(election.tp) === '8' ? 'federal' : 'estadual',
				data: electionEvent.dt || null,
				ciclo: cycle || `ele${year}`,
			});
		}
	}

	return {
		ano: Number(year),
		resultadosDisponiveis: elections.length > 0,
		fase: elections.length > 0 ? (String(catalog.f).toLowerCase() === 's' ? 'simulado' : 'oficial') : 'aguardando_tse',
		eleicoes: elections,
		amostra: {
			ano: 2022,
			disponivel: true,
			endpoint: '/api/apuracao?ano=2022&turno=1&cargo=1&uf=br',
		},
		candidatos: {
			publicadosPeloTse: true,
			disponiveisNaApi: elections.length > 0,
			atualizacao: 'diaria',
			fonte: TSE_CANDIDATES_2026_URL,
		},
	};
}

export async function loadElectionResult(params, options = {}) {
	if (params.year === '2022') {
		const legacy = buildLegacyResultUrl(params);
		const data = await fetchTseJson(legacy.url);
		return {
			payload: normalizeLegacyResult(data, params, legacy.electionCode),
			raw: data,
			sourceUrl: legacy.url,
		};
	}

	const catalog = options.catalog || (await fetchElectionCatalog());
	const selection = findElectionInCatalog(catalog, params);

	if (!selection) {
		throw new ApiError(503, 'ELEICAO_AGUARDANDO_TSE', 'A configuração oficial dos resultados de 2026 ainda não foi publicada pelo TSE.', {
			statusEleicao: '/api/status-eleicao?ano=2026',
		});
	}

	const resultUrl = buildUnifiedResultUrl(selection, params);
	const data = await fetchTseJson(resultUrl);
	return {
		payload: normalizeUnifiedResult(data, params, selection),
		raw: data,
		sourceUrl: resultUrl,
	};
}

export async function getElectionResult(params, options = {}) {
	return (await loadElectionResult(params, options)).payload;
}

export function normalizeUnifiedResult(data, params, selection) {
	const candidates = [];
	let vacancies = null;

	for (const office of data.carg || []) {
		if (String(office.cd) === params.office && office.nv != null) {
			vacancies = toInteger(office.nv);
		}

		for (const aggregation of office.agr || []) {
			for (const party of aggregation.par || []) {
				for (const candidate of party.cand || []) {
					candidates.push(normalizeCandidate(candidate, {
						party: party.sg || '',
						partyName: party.nm || '',
						composition: aggregation.com || '',
						photoUrl: buildPhotoUrl(selection.cycle, selection.electionCode, params.uf, candidate.sqcand),
					}));
				}
			}
		}
	}

	candidates.sort((left, right) => right.votosNumero - left.votosNumero);

	return buildResultPayload({
		data,
		params,
		selection,
		candidates,
		vacancies,
		sections: data.s || {},
		electors: data.e || {},
		votes: data.v || {},
	});
}

export function normalizeLegacyResult(data, params, electionCode) {
	if (!Array.isArray(data.cand)) {
		throw new ApiError(502, 'ESTRUTURA_TSE_INVALIDA', 'A resposta do TSE não contém a lista de candidatos esperada.');
	}

	const candidates = data.cand
		.map((candidate) => normalizeCandidate(candidate, {
			party: String(candidate.cc || '').split(' - ')[0],
			partyName: '',
			composition: candidate.cc || '',
			photoUrl: buildPhotoUrl('ele2022', electionCode, params.uf, candidate.sqcand),
		}))
		.sort((left, right) => right.votosNumero - left.votosNumero);

	return buildResultPayload({
		data,
		params,
		selection: {
			cycle: 'ele2022',
			electionCode,
			electionName: 'Eleições Gerais 2022',
			electionDate: null,
		},
		candidates,
		vacancies: null,
		sections: data,
		electors: data,
		votes: data,
	});
}

function normalizeCandidate(candidate, context) {
	const status = decodeHtmlEntities(candidate.st || '');
	const normalizedStatus = status.trim().toLocaleLowerCase('pt-BR');
	const votes = toInteger(candidate.vap);
	const electedOrSecondRound = String(candidate.e || '').toLowerCase() === 's';
	const wentToSecondRound = normalizedStatus === '2º turno' || normalizedStatus === '2° turno';

	return {
		nome: decodeHtmlEntities(candidate.nmu || candidate.nm || ''),
		nomeCompleto: decodeHtmlEntities(candidate.nm || candidate.nmu || ''),
		numero: candidate.n == null ? null : String(candidate.n),
		partido: decodeHtmlEntities(context.party),
		nomePartido: decodeHtmlEntities(context.partyName),
		composicao: decodeHtmlEntities(context.composition),
		votos: normalizeDecimal(candidate.pvap),
		votosNumero: votes,
		total: votes.toLocaleString('pt-BR'),
		eleito: ELECTED_STATUSES.has(normalizedStatus) || (electedOrSecondRound && !wentToSecondRound),
		situacao: status || null,
		destinacaoVoto: decodeHtmlEntities(candidate.dvt || '') || null,
		foto: context.photoUrl,
		viceSuplentes: (candidate.vs || []).map((person) => ({
			tipo: person.tp,
			nome: decodeHtmlEntities(person.nmu || person.nm || ''),
			partido: decodeHtmlEntities(person.sgp || ''),
		})),
	};
}

function buildResultPayload({ data, params, selection, candidates, vacancies, sections, electors, votes }) {
	const validVotes = toInteger(votes.vv);
	const totalVotes = toInteger(votes.tv);

	return {
		ano: Number(params.year),
		turno: Number(params.round),
		cargo: Number(params.office),
		uf: params.uf,
		fonte: 'Tribunal Superior Eleitoral',
		fase: String(data.f || '').toLowerCase() === 's' ? 'simulado' : 'oficial',
		finalizado: String(data.tf || '').toLowerCase() === 's',
		andamento: data.and || null,
		idGeracao: data.idg ?? null,
		eleicao: {
			codigo: selection.electionCode,
			nome: selection.electionName,
			data: selection.electionDate,
			ciclo: selection.cycle,
		},
		percurso: sections.pst || '0,00',
		atualizacao: formatUpdate(data.dg, data.hg),
		vagas: vacancies,
		resumo: {
			validos: formatInteger(validVotes),
			pctValidos: calculatePercentage(validVotes, totalVotes),
			brancos: formatInteger(votes.vb),
			pctBrancos: normalizeBrazilianDecimal(votes.pvb),
			nulos: formatInteger(votes.tvn),
			pctNulos: normalizeBrazilianDecimal(votes.ptvn),
			abstencoes: formatInteger(electors.a),
			pctAbstencoes: normalizeBrazilianDecimal(electors.pa),
		},
		totalCandidatos: candidates.length,
		candidatos: candidates,
	};
}

function buildPhotoUrl(cycle, electionCode, uf, candidateSequence) {
	if (!candidateSequence) {
		return null;
	}
	return `${TSE_RESULTS_BASE_URL}/oficial/${cycle}/${electionCode}/fotos/${uf}/${candidateSequence}.jpeg`;
}

function toInteger(value) {
	const parsed = Number.parseInt(String(value ?? '0'), 10);
	return Number.isFinite(parsed) ? parsed : 0;
}

function formatInteger(value) {
	if (value === null || value === undefined || value === '') {
		return '--';
	}
	return toInteger(value).toLocaleString('pt-BR');
}

function normalizeDecimal(value) {
	if (value === null || value === undefined || value === '') {
		return '0.00';
	}
	return String(value).replace(',', '.');
}

function normalizeBrazilianDecimal(value) {
	if (value === null || value === undefined || value === '') {
		return '0,00';
	}
	return String(value).replace('.', ',');
}

function calculatePercentage(value, total) {
	if (!total) {
		return '0,00';
	}
	return ((value / total) * 100).toFixed(2).replace('.', ',');
}

function formatUpdate(date, time) {
	if (!date && !time) {
		return null;
	}
	if (!date) {
		return String(time);
	}
	if (!time) {
		return String(date);
	}
	return `${date} às ${time}`;
}

function decodeHtmlEntities(value) {
	return String(value)
		.replaceAll('&apos;', "'")
		.replaceAll('&#39;', "'")
		.replaceAll('&quot;', '"')
		.replaceAll('&amp;', '&')
		.replaceAll('&lt;', '<')
		.replaceAll('&gt;', '>')
		.replaceAll('&#186;', 'º');
}
