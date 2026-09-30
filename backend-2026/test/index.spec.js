import { env, exports as workerExports } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import worker from '../src';
import {
	buildResultSnapshotKey,
	buildStatusSnapshotKey,
	isFreshSnapshot,
	readSnapshot,
	withContingencyMetadata,
	writeSnapshot,
} from '../src/snapshot.js';
import {
	buildUnifiedResultUrl,
	findElectionInCatalog,
	getElectionStatus,
	normalizeUnifiedResult,
	validateElectionParams,
} from '../src/tse.js';

describe('API Eleicoes 2026', () => {
	it('e um Worker independente dedicado a 2026', async () => {
		const request = new Request('http://example.com/');
		const context = createExecutionContext();
		const response = await worker.fetch(request, env, context);
		await waitOnExecutionContext(context);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			status: 'online',
			servico: 'API Eleições 2026',
			anoPadrao: 2026,
			ambienteTse: 'oficial',
		});
	});

	it('funciona no runtime integrado da Cloudflare', async () => {
		const response = await workerExports.default.fetch('http://example.com/');
		expect(response.status).toBe(200);
		expect((await response.json()).anoPadrao).toBe(2026);
	});

	it('mantem o CORS compativel com o front atual', async () => {
		for (const port of [5500, 5501]) {
			const origin = `http://127.0.0.1:${port}`;
			const response = await workerExports.default.fetch('http://example.com/api/calendario', {
				headers: { Origin: origin },
			});

			expect(response.status).toBe(200);
			expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
		}
	});

	it('nao aceita 2022 no backend isolado de 2026', () => {
		expect(() => validateElectionParams(new URLSearchParams('ano=2022'))).toThrowError(
			'Este backend aceita somente a eleição de 2026.',
		);
	});

	it('publica as tres janelas oficiais de simulados', async () => {
		const response = await workerExports.default.fetch('http://example.com/api/calendario');
		const body = await response.json();

		expect(body.primeiroTurno).toBe('04/10/2026');
		expect(body.simulados).toHaveLength(3);
		expect(body.simulados[0].datas).toContain('15/09/2026');
		expect(body.simulados[1].datas).toContain('24/09/2026');
		expect(body.simulados[2]).toEqual({
			datas: ['28/09/2026', '29/09/2026'],
			horariosBrasilia: ['15:00-17:00'],
		});
	});
});

describe('Snapshots persistentes', () => {
	function createMemoryKv() {
		const values = new Map();
		return {
			async getWithMetadata(key) {
				return values.get(key) || { value: null, metadata: null };
			},
			async put(key, serialized, options) {
				values.set(key, { value: JSON.parse(serialized), metadata: options.metadata });
			},
		};
	}

	it('separa chaves por ambiente e filtro eleitoral', () => {
		expect(buildStatusSnapshotKey('oficial')).toBe('eleicoes:1:oficial:status:2026');
		expect(buildResultSnapshotKey('oficial', { year: '2026', round: '1', office: '3', uf: 'mt' })).toBe(
			'eleicoes:1:oficial:apuracao:2026:1:3:mt',
		);
	});

	it('salva e recupera o ultimo resultado valido com sua idade', async () => {
		const kv = createMemoryKv();
		const key = buildStatusSnapshotKey('oficial');
		const now = Date.parse('2026-10-04T20:00:00.000Z');
		await writeSnapshot(kv, key, { ano: 2026, idGeracao: 42 }, now);

		const snapshot = await readSnapshot(kv, key, now + 90_000);
		expect(snapshot).toMatchObject({
			value: { ano: 2026, idGeracao: 42 },
			storedAt: '2026-10-04T20:00:00.000Z',
			ageSeconds: 90,
		});
		expect(isFreshSnapshot(snapshot, 120)).toBe(true);
		expect(isFreshSnapshot(snapshot, 60)).toBe(false);
	});

	it('identifica claramente uma resposta entregue em contingencia', () => {
		const snapshot = {
			value: { ano: 2026, percurso: '50,00' },
			storedAt: '2026-10-04T20:00:00.000Z',
			ageSeconds: 180,
		};
		const value = withContingencyMetadata(snapshot.value, snapshot, 'TSE_INDISPONIVEL');

		expect(value.contingencia).toEqual({
			ativa: true,
			motivo: 'TSE_INDISPONIVEL',
			ultimoResultadoSalvoEm: '2026-10-04T20:00:00.000Z',
			idadeSegundos: 180,
		});
	});

	it('entrega o ultimo resultado salvo quando o TSE fica indisponivel', async () => {
		const kv = createMemoryKv();
		const params = { year: '2026', round: '1', office: '1', uf: 'br' };
		const key = buildResultSnapshotKey('oficial', params);
		await writeSnapshot(
			kv,
			key,
			{ ano: 2026, turno: 1, cargo: 1, uf: 'br', percurso: '63,50', idGeracao: 99 },
			Date.now() - 300_000,
		);

		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('TSE offline'));
		const request = new Request('https://fallback.example/api/apuracao?ano=2026&turno=1&cargo=1&uf=br', {
			headers: { Origin: 'https://eleicoes-front.vercel.app' },
		});
		const context = createExecutionContext();
		const response = await worker.fetch(
			request,
			{
				TSE_ENVIRONMENT: 'oficial',
				TSE_RESULTS_ROOT: 'https://resultados.tse.jus.br/oficial',
				CACHE_TTL_SECONDS: '120',
				ELECTION_RESULTS_KV: kv,
			},
			context,
		);
		await waitOnExecutionContext(context);
		fetchSpy.mockRestore();

		expect(response.status).toBe(200);
		expect(response.headers.get('X-Data-Source')).toBe('kv-stale');
		expect(response.headers.get('Warning')).toContain('Resposta em contingencia');
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://eleicoes-front.vercel.app');
		expect(await response.json()).toMatchObject({
			percurso: '63,50',
			contingencia: { ativa: true, idadeSegundos: 300 },
		});
	});
});

describe('EA11 de 2026', () => {
	const catalog = {
		dg: '15/09/2026',
		hg: '09:30:00',
		idg: 100,
		f: 's',
		pl: [
			{
				cd: 500,
				c: 'ele2026',
				dt: '04/10/2026',
				e: [
					{
						cd: 700,
						nm: 'Eleição Estadual 2026 - 1&#186; turno',
						t: 1,
						tp: 1,
						abr: [{ cd: 'mt', cp: [{ cd: 3, ds: 'Governador' }] }],
					},
				],
			},
		],
	};

	it('descobre os codigos sem numeros fixos no codigo-fonte', () => {
		const params = { year: '2026', round: '1', office: '3', uf: 'mt' };
		const election = findElectionInCatalog(catalog, params);

		expect(election).toMatchObject({
			cycle: 'ele2026',
			electionCode: '700',
			pleitoCode: '500',
			electionName: 'Eleição Estadual 2026 - 1º turno',
		});
		expect(buildUnifiedResultUrl(election, params, 'https://resultados.tse.jus.br/simulado')).toBe(
			'https://resultados.tse.jus.br/simulado/ele2026/700/dados/mt/mt-c0003-e000700-u.json',
		);
	});

	it('aceita cargo estadual anunciado na abrangencia nacional do catalogo', () => {
		const catalogComAbrangenciaNacional = structuredClone(catalog);
		catalogComAbrangenciaNacional.pl[0].e[0].abr = [{ cd: 'br', cp: [{ cd: 3, ds: 'Governador' }] }];

		const params = { year: '2026', round: '1', office: '3', uf: 'mt' };
		const election = findElectionInCatalog(catalogComAbrangenciaNacional, params);

		expect(election).toMatchObject({
			cycle: 'ele2026',
			electionCode: '700',
		});
		expect(buildUnifiedResultUrl(election, params, 'https://resultados-sim.tse.jus.br/simulado/simulado2026')).toBe(
			'https://resultados-sim.tse.jus.br/simulado/simulado2026/ele2026/700/dados/mt/mt-c0003-e000700-u.json',
		);
	});

	it('informa a fase simulada e as eleicoes disponiveis', async () => {
		const status = await getElectionStatus(
			{ TSE_ENVIRONMENT: 'simulado', TSE_RESULTS_ROOT: 'https://resultados.tse.jus.br/simulado' },
			{ catalog },
		);

		expect(status).toMatchObject({
			ano: 2026,
			resultadosDisponiveis: true,
			fase: 'simulado',
			ambiente: 'simulado',
		});
		expect(status.eleicoes).toHaveLength(1);
	});
});

describe('EA20 de 2026', () => {
	it('mantem o mesmo contrato de resultado consumido pelo front', () => {
		const result = normalizeUnifiedResult(
			{
				f: 's',
				tf: 'n',
				and: 'p',
				idg: 42,
				dg: '15/09/2026',
				hg: '10:00:00',
				carg: [
					{
						cd: 1,
						nv: 1,
						agr: [
							{
								com: 'Partido A / Partido B',
								par: [
									{
										sg: 'PA',
										nm: 'Partido A',
										cand: [
											{ n: 10, nm: 'Nome Completo', nmu: 'CANDIDATO', sqcand: '123', e: 'n', st: '', vap: 600, pvap: '60,00' },
										],
									},
								],
							},
						],
					},
				],
				s: { pst: '50,00' },
				e: { a: 100, pa: '10,00' },
				v: { tv: 1000, vv: 850, vb: 50, pvb: '5,00', tvn: 100, ptvn: '10,00' },
			},
			{ year: '2026', round: '1', office: '1', uf: 'br' },
			{ cycle: 'ele2026', electionCode: '700', electionName: 'Eleição Federal 2026', electionDate: '04/10/2026' },
		);

		expect(result).toMatchObject({
			ano: 2026,
			turno: 1,
			cargo: 1,
			uf: 'br',
			fase: 'simulado',
			finalizado: false,
			percurso: '50,00',
			totalCandidatos: 1,
		});
		expect(result.resumo.pctValidos).toBe('85,00');
		expect(result.candidatos[0]).toMatchObject({ nome: 'CANDIDATO', partido: 'PA', votos: '60.00' });
	});
});
