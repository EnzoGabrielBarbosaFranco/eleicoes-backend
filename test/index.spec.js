import { createExecutionContext, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src';
import { refreshElectionData } from '../src/collector.js';
import {
	publicResultKey,
	readCollectorStatus,
	readElectionStatusSnapshot,
	readResultSnapshot,
	resultSnapshotKey,
	writeResultSnapshot,
} from '../src/snapshots.js';
import {
	findElectionInCatalog,
	normalizeLegacyResult,
	normalizeUnifiedResult,
	validateElectionParams,
} from '../src/tse.js';

describe('API Eleicoes', () => {
	it('informa que o Worker esta online', async () => {
		const request = new Request('http://example.com/');
		const context = createExecutionContext();
		const response = await worker.fetch(request, env, context);
		await waitOnExecutionContext(context);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			status: 'online',
			anoPadrao: 2022,
			anoEleicaoAtual: 2026,
		});
	});

	it('funciona pelo runtime integrado da Cloudflare', async () => {
		const response = await SELF.fetch('http://example.com/');
		expect(response.status).toBe(200);
		expect((await response.json()).servico).toBe('API Eleições');
	});

	it('permite o Live Server local no CORS', async () => {
		for (const port of [5500, 5501]) {
			const origin = `http://127.0.0.1:${port}`;
			const response = await SELF.fetch('http://example.com/', {
				headers: { Origin: origin },
			});

			expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
			expect(response.headers.get('Vary')).toContain('Origin');
		}
	});

	it('recusa metodos que alteram estado', async () => {
		const response = await SELF.fetch('http://example.com/api/apuracao', { method: 'POST' });
		const body = await response.json();

		expect(response.status).toBe(405);
		expect(response.headers.get('Allow')).toBe('GET, HEAD, OPTIONS');
		expect(body.codigo).toBe('METODO_NAO_PERMITIDO');
	});

	it('valida cargo sem segundo turno antes de consultar o TSE', async () => {
		const response = await SELF.fetch('http://example.com/api/apuracao?ano=2026&turno=2&cargo=5&uf=mt');
		const body = await response.json();

		expect(response.status).toBe(400);
		expect(body.codigo).toBe('SEM_SEGUNDO_TURNO');
	});
});

describe('configuracao eleitoral', () => {
	it('usa 2022 como amostra padrao e normaliza os parametros', () => {
		const params = validateElectionParams(new URLSearchParams('turno=1&cargo=3&uf=SP'));
		expect(params).toEqual({ year: '2022', round: '1', office: '3', uf: 'sp' });
	});

	it('descobre os codigos no EA11 sem IDs fixos', () => {
		const catalog = {
			pl: [
				{
					cd: 500,
					c: 'ele2026',
					dt: '04/10/2026',
					e: [
						{
							cd: 700,
							nm: 'Eleição Estadual 2026',
							t: 1,
							tp: 1,
							abr: [{ cd: 'br', cp: [{ cd: 3, ds: 'Governador' }] }],
						},
					],
				},
			],
		};

		expect(findElectionInCatalog(catalog, { year: '2026', round: '1', office: '3', uf: 'mt' })).toMatchObject({
			cycle: 'ele2026',
			electionCode: '700',
			pleitoCode: '500',
		});
	});
});

describe('normalizacao dos resultados', () => {
	it('le candidatos na estrutura EA20 e nao confunde segundo turno com eleito', () => {
		const result = normalizeUnifiedResult(
			{
				f: 's',
				tf: 'n',
				and: 'p',
				idg: 42,
				dg: '04/10/2026',
				hg: '18:30:00',
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
											{
												n: 10,
												nm: 'Candidato Completo',
												nmu: 'CANDIDATO',
												sqcand: '123',
												e: 's',
												st: '2º turno',
												vap: 600,
												pvap: '60,00',
											},
											{
												n: 20,
												nm: 'Candidato Definido',
												nmu: 'DEFINIDO',
												sqcand: '456',
												e: 's',
												st: '',
												vap: 500,
												pvap: '50,00',
											},
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

		expect(result.fase).toBe('simulado');
		expect(result.vagas).toBe(1);
		expect(result.resumo.pctValidos).toBe('85,00');
		expect(result.totalCandidatos).toBe(2);
		expect(result.candidatos[0]).toMatchObject({
			nome: 'CANDIDATO',
			partido: 'PA',
			eleito: false,
			situacao: '2º turno',
		});
		expect(result.candidatos[1].eleito).toBe(true);
	});

	it('preserva todos os candidatos do resultado historico', () => {
		const candidates = Array.from({ length: 50 }, (_, index) => ({
			nm: `CANDIDATO ${index + 1}`,
			cc: 'PX - PARTIDO X',
			e: 'n',
			st: 'Não eleito',
			vap: String(50 - index),
			pvap: '1,00',
			sqcand: String(index + 1),
		}));

		const result = normalizeLegacyResult(
			{
				f: 'o',
				tf: 's',
				pst: '100,00',
				dg: '04/10/2022',
				hg: '12:00:00',
				vv: '850',
				tv: '1000',
				vb: '50',
				pvb: '5,00',
				tvn: '100',
				ptvn: '10,00',
				a: '100',
				pa: '10,00',
				cand: candidates,
			},
			{ year: '2022', round: '1', office: '7', uf: 'sp' },
			'546',
		);

		expect(result.totalCandidatos).toBe(50);
		expect(result.candidatos).toHaveLength(50);
	});
});

describe('coleta persistente', () => {
	it('serve um snapshot do R2 sem consultar o TSE', async () => {
		const params = { year: '2022', round: '1', office: '6', uf: 'rr' };
		const payload = samplePayload(params, 101);
		await writeResultSnapshot(env, params, {
			payload,
			raw: { origem: 'teste' },
			sourceUrl: 'https://resultados.tse.jus.br/teste.json',
		});

		const request = new Request('http://snapshot.test/api/apuracao?ano=2022&turno=1&cargo=6&uf=rr');
		const context = createExecutionContext();
		const response = await worker.fetch(
			request,
			{ ...env, ELECTION_DATA: env.ELECTION_DATA, ALLOW_ON_DEMAND_TSE_FETCH: 'false' },
			context,
		);
		await waitOnExecutionContext(context);

		expect(response.status).toBe(200);
		expect(response.headers.get('X-Data-Source')).toBe('R2');
		expect(response.headers.get('X-Data-Stale')).toBe('false');
		expect(await response.json()).toEqual(payload);
		const publicObject = await env.ELECTION_DATA.get(publicResultKey(params));
		expect(Boolean(publicObject)).toBe(true);
		expect(await publicObject.json()).toEqual(payload);
	});

	it('nao consulta o TSE sob demanda quando a protecao esta ativa', async () => {
		const params = { year: '2026', round: '2', office: '3', uf: 'rr' };
		await env.ELECTION_DATA.delete(resultSnapshotKey(params));

		const request = new Request('http://cold.test/api/apuracao?ano=2026&turno=2&cargo=3&uf=rr');
		const context = createExecutionContext();
		const response = await worker.fetch(
			request,
			{ ...env, ELECTION_DATA: env.ELECTION_DATA, ALLOW_ON_DEMAND_TSE_FETCH: 'false' },
			context,
		);
		await waitOnExecutionContext(context);

		expect(response.status).toBe(503);
		expect(response.headers.get('Retry-After')).toBe('120');
		expect((await response.json()).codigo).toBe('DADOS_AQUECENDO');
	});

	it('atualiza feeds configurados e registra a saude do coletor', async () => {
		const params = { year: '2026', round: '1', office: '3', uf: 'mt' };
		await env.ELECTION_DATA.delete(resultSnapshotKey(params));
		const payload = samplePayload(params, 2026);
		let resultLoads = 0;

		const collectorEnv = {
			...env,
			ELECTION_DATA: env.ELECTION_DATA,
			ELECTION_FEEDS: [{ ano: 2026, turno: 1, cargo: 3, uf: 'mt' }],
			TSE_MAX_REQUESTS_PER_SECOND: '5',
		};
		const status = await refreshElectionData(collectorEnv, {
			fetchElectionCatalog: async () => ({ f: 's', pl: [] }),
			getElectionStatus: async () => ({ ano: 2026, resultadosDisponiveis: true, fase: 'simulado' }),
			loadElectionResult: async () => {
				resultLoads += 1;
				return {
					payload,
					raw: { idg: 2026, carg: [] },
					sourceUrl: 'https://resultados.tse.jus.br/simulado.json',
				};
			},
			wait: async () => {},
		});

		expect(resultLoads).toBe(1);
		expect(status.resultados[0].status).toBe('atualizado');
		expect((await readResultSnapshot(collectorEnv, params)).data).toEqual(payload);
		expect((await readElectionStatusSnapshot(collectorEnv, '2026')).data.fase).toBe('simulado');
		expect((await readCollectorStatus(collectorEnv)).feedsConfigurados).toBe(1);
	});
});

function samplePayload(params, idGeracao) {
	return {
		ano: Number(params.year),
		turno: Number(params.round),
		cargo: Number(params.office),
		uf: params.uf,
		fonte: 'Tribunal Superior Eleitoral',
		fase: params.year === '2022' ? 'oficial' : 'simulado',
		finalizado: params.year === '2022',
		andamento: params.year === '2022' ? 'f' : 'p',
		idGeracao,
		candidatos: [],
		totalCandidatos: 0,
	};
}
