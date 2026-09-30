export const ELECTION_YEAR = '2026';
export const DEFAULT_TSE_RESULTS_ROOT = 'https://resultados.tse.jus.br/oficial';
export const TSE_CANDIDATES_2026_URL = 'https://dadosabertos.tse.jus.br/dataset/candidatos-2026';

export const ELECTION_2026_SCHEDULE = Object.freeze({
	primeiroTurno: '04/10/2026',
	segundoTurno: '25/10/2026',
	simulados: [
		{ datas: ['15/09/2026', '16/09/2026', '17/09/2026'], horariosBrasilia: ['09:00-12:00', '14:00-17:00'] },
		{ datas: ['22/09/2026', '23/09/2026', '24/09/2026'], horariosBrasilia: ['09:00-12:00', '14:00-17:00'] },
		{ datas: ['28/09/2026', '29/09/2026'], horariosBrasilia: ['15:00-17:00'] },
	],
});

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

export class ApiError extends Error {
	constructor(status, code, message, details) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.code = code;
		this.details = details;
	}
}

export function getTseSettings(env = {}) {
	const environment = String(env.TSE_ENVIRONMENT || 'oficial').trim().toLowerCase();
	const resultsRoot = String(env.TSE_RESULTS_ROOT || DEFAULT_TSE_RESULTS_ROOT).trim().replace(/\/+$/, '');
	const catalogUrl = String(env.TSE_CATALOG_URL || `${resultsRoot}/comum/config/ele-c.json`).trim();

	if (!['oficial', 'simulado'].includes(environment)) {
		throw new ApiError(500, 'AMBIENTE_TSE_INVALIDO', 'O ambiente do TSE deve ser oficial ou simulado.');
	}

	if (!resultsRoot.startsWith('https://')) {
		throw new ApiError(500, 'URL_TSE_INVALIDA', 'A raiz de resultados do TSE deve utilizar HTTPS.');
	}

	return { environment, resultsRoot, catalogUrl };
}

export function validateElectionParams(searchParams) {
	const year = String(searchParams.get('ano') || ELECTION_YEAR).trim();
	const round = String(searchParams.get('turno') || '1').trim();
	const office = String(searchParams.get('cargo') || '1').trim();
	const uf = String(searchParams.get('uf') || 'br').trim().toLowerCase();

	if (year !== ELECTION_YEAR) {
		throw new ApiError(400, 'ANO_INVALIDO', 'Este backend aceita somente a eleição de 2026.');
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

	for (const electionEvent of catalog.pl || []) {
		const eventYear = String(electionEvent.dt || '').slice(-4);
		const cycle = String(electionEvent.c || '').toLowerCase();

		if (cycle !== 'ele2026' && eventYear !== ELECTION_YEAR) {
			continue;
		}

		for (const election of electionEvent.e || []) {
			if (String(election.t) !== params.round || String(election.tp) !== expectedElectionType) {
				continue;
			}

			const scopes = election.abr || [];
			// No EA11 do simulado 2026, o TSE anuncia os cargos estaduais na
			// abrangencia `br`, embora os arquivos EA20 continuem separados por UF.
			const scope =
				scopes.find((item) => String(item.cd).toLowerCase() === params.uf) ||
				scopes.find((item) => String(item.cd).toLowerCase() === 'br');
			const hasOffice = scope?.cp?.some((item) => String(item.cd) === params.office);

			if (!scope || !hasOffice) {
				continue;
			}

			return {
				cycle: cycle || 'ele2026',
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

export function buildUnifiedResultUrl(selection, params, resultsRoot = DEFAULT_TSE_RESULTS_ROOT) {
	const electionCode = selection.electionCode.padStart(6, '0');
	const officeCode = params.office.padStart(4, '0');
	return `${resultsRoot}/${selection.cycle}/${selection.electionCode}/dados/${params.uf}/${params.uf}-c${officeCode}-e${electionCode}-u.json`;
}

export async function fetchElectionCatalog(env = {}, options = {}) {
	const settings = getTseSettings(env);
	return fetchTseJson(settings.catalogUrl, options.fetchImpl || fetch);
}

export async function getElectionStatus(env = {}, options = {}) {
	const settings = getTseSettings(env);
	let catalog;

	try {
		catalog = options.catalog || (await fetchElectionCatalog(env, options));
	} catch (error) {
		if (error instanceof ApiError && error.status === 404) {
			return buildWaitingStatus(settings, 'CATALOGO_AGUARDANDO_TSE');
		}
		throw error;
	}

	const elections = listElections(catalog);

	return {
		ano: 2026,
		resultadosDisponiveis: elections.length > 0,
		fase: elections.length > 0 ? (String(catalog.f).toLowerCase() === 's' ? 'simulado' : 'oficial') : 'aguardando_tse',
		ambiente: settings.environment,
		catalogo: {
			disponivel: true,
			geradoEm: formatUpdate(catalog.dg, catalog.hg),
			idGeracao: catalog.idg ?? null,
		},
		eleicoes: elections,
		calendario: ELECTION_2026_SCHEDULE,
		candidatos: {
			publicadosPeloTse: true,
			disponiveisNosResultados: elections.length > 0,
			fonte: TSE_CANDIDATES_2026_URL,
		},
	};
}

export async function loadElectionResult(params, env = {}, options = {}) {
	const settings = getTseSettings(env);
	const catalog = options.catalog || (await fetchElectionCatalog(env, options));
	const selection = findElectionInCatalog(catalog, params);

	if (!selection) {
		throw new ApiError(503, 'ELEICAO_AGUARDANDO_TSE', 'A configuração dos resultados de 2026 ainda não está disponível neste ambiente do TSE.', {
			ambiente: settings.environment,
			statusEleicao: '/api/status-eleicao?ano=2026',
		});
	}

	const resultUrl = buildUnifiedResultUrl(selection, params, settings.resultsRoot);
	const data = await fetchTseJson(resultUrl, options.fetchImpl || fetch);

	return normalizeUnifiedResult(data, params, selection, settings.resultsRoot);
}

export function normalizeUnifiedResult(data, params, selection, resultsRoot = DEFAULT_TSE_RESULTS_ROOT) {
	const candidates = [];
	let vacancies = null;

	for (const office of data.carg || []) {
		if (String(office.cd) !== params.office) {
			continue;
		}

		if (office.nv != null) {
			vacancies = toInteger(office.nv);
		}

		for (const aggregation of office.agr || []) {
			for (const party of aggregation.par || []) {
				for (const candidate of party.cand || []) {
					candidates.push(
						normalizeCandidate(candidate, {
							party: party.sg || '',
							partyName: party.nm || '',
							composition: aggregation.com || '',
							photoUrl: buildPhotoUrl(resultsRoot, selection.cycle, selection.electionCode, params.uf, candidate.sqcand),
						}),
					);
				}
			}
		}
	}

	candidates.sort((left, right) => right.votosNumero - left.votosNumero);

	const votes = data.v || {};
	const electors = data.e || {};
	const sections = data.s || {};
	const validVotes = toInteger(votes.vv);
	const totalVotes = toInteger(votes.tv);

	return {
		ano: 2026,
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

function listElections(catalog) {
	const elections = [];

	for (const electionEvent of catalog.pl || []) {
		const eventYear = String(electionEvent.dt || '').slice(-4);
		const cycle = String(electionEvent.c || '').toLowerCase();

		if (cycle !== 'ele2026' && eventYear !== ELECTION_YEAR) {
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
				ciclo: cycle || 'ele2026',
			});
		}
	}

	return elections;
}

function buildWaitingStatus(settings, code) {
	return {
		ano: 2026,
		resultadosDisponiveis: false,
		fase: 'aguardando_tse',
		ambiente: settings.environment,
		codigo: code,
		catalogo: { disponivel: false, geradoEm: null, idGeracao: null },
		eleicoes: [],
		calendario: ELECTION_2026_SCHEDULE,
		candidatos: {
			publicadosPeloTse: true,
			disponiveisNosResultados: false,
			fonte: TSE_CANDIDATES_2026_URL,
		},
	};
}

async function fetchTseJson(url, fetchImpl) {
	let response;

	try {
		response = await fetchImpl(url, {
			headers: {
				Accept: 'application/json',
				'User-Agent': 'Mozilla/5.0 (compatible; backend-eleicoes-2026/1.0)',
			},
			signal: AbortSignal.timeout(10_000),
		});
	} catch (error) {
		throw new ApiError(502, 'TSE_INDISPONIVEL', 'Não foi possível conectar ao TSE.', {
			cause: error instanceof Error ? error.message : String(error),
		});
	}

	if (response.status === 404) {
		response.body?.cancel();
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

function normalizeCandidate(candidate, context) {
	const status = decodeHtmlEntities(candidate.st || '');
	const normalizedStatus = status.trim().toLocaleLowerCase('pt-BR');
	const votes = toInteger(candidate.vap);
	const electedOrSecondRound = String(candidate.e || '').toLowerCase() === 's';
	const wentToSecondRound = ['2º turno', '2° turno'].includes(normalizedStatus);

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

function buildPhotoUrl(resultsRoot, cycle, electionCode, uf, candidateSequence) {
	if (!candidateSequence) {
		return null;
	}
	return `${resultsRoot}/${cycle}/${electionCode}/fotos/${uf}/${candidateSequence}.jpeg`;
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
		.replaceAll('&#186;', 'º')
		.replaceAll('&ordm;', 'º');
}
