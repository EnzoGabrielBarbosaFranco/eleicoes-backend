import { createExecutionContext, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src';
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
