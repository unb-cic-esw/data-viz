/*	Required modules */
const ChartNode = require("chartjs-node");
const mongoose = require("mongoose");
const Color = require("./color.controller");
const youtubeAccount = require("../models/youtube.model");
const logger = require("../../config/logger");
const ResocieObs = require("../../config/resocie.json").observatory;
const httpStatus = require("../../config/resocie.json").httpStatus;

/*	Global constants */
const CHART_SIZE = 700;
const MAX_LEN_LABEL = 80;
const SOCIAL_MIDIA = ResocieObs.socialMidia.youtubeMidia;

/*	Route final methods */
/**
 * Search for all YouTube Accounts on the database.
 * @param {object} req - standard req object from the Express library
 * @param {object} res - standard res object from the Express library
 * @return {object} accounts - list all accounts showing the name of valid accounts
 */
const listAccounts = async (req, res) => {
	try {
		const accounts = await youtubeAccount.find({}, "name channel -_id");

		const importLink = await getInitialLink(req, accounts);

		res.status(httpStatus.OK).json({
			error: false,
			import: importLink,
			accounts,
		});
	} catch (error) {
		const errorMsg = `Erro ao carregar usuários do ${capitalize(SOCIAL_MIDIA)} nos registros`;

		stdErrorHand(res, httpStatus.ERROR_LIST_ACCOUNTS, errorMsg, error);
	}
};

/**
 * Insert YouTube accounts available from spreadsheet to database
 * @param {object} req - standard req object from the Express library
 * @param {object} res - standard res object from the Express library
 * @return {redirect} - redirect for /youtube page if import successful
 */

const importData = async (req, res) => {
	const actors = {};
	const tabs = req.collectives;
	const length = tabs.length;
	const categories = req.sheet.categories;
	const youtubeRange = req.sheet.youtubeRange;
	const nameRow = req.sheet.range.nameRow;
	const dateRow = youtubeRange.dateRow;
	const channelRow = youtubeRange.channelRow;
	const subscribsRow = youtubeRange.subscribsRow;
	const videosRow = youtubeRange.videosRow;
	const viewsRow = youtubeRange.viewsRow;
	let cCategory;
	let lastDate;

	mongoose.connection.collections.youtubeAccount.drop();
	for (let i = 0; i < length; i += 1) {
		const cTab = tabs[i];
		const rowsCount = cTab.length;
		cCategory = 0;

		for (let j = 0; j < rowsCount; j += 1) {
			const cRow = cTab[j];

			// se a row for vazia ou a primeira, continua
			if (j < 1 || !(cRow[nameRow])) {
				continue; // eslint-disable-line no-continue
			}

			// Se estivermos na row que indicao o novo tipo, atualiza
			// a string do tipo atual e continua para a próxima row
			if (cRow[nameRow] === categories[cCategory + 1]) {
				cCategory += 1;
				continue; // eslint-disable-line no-continue
			}
			// Se o canal é válido, cria um novo schema para o canal
			const channelUrl = getImportChannelURL(cRow[channelRow]);

			// Caso não exista o usuario atual, cria um novo schema para o usuario
			if (actors[cRow[nameRow]] === undefined) {
				const newAccount = youtubeAccount({
					name: cRow[nameRow].replace(/\n/g, " "),
					category: categories[cCategory],
					channelUrl: channelUrl,
					channel: getImportUsername(channelUrl),
				});
				actors[cRow[nameRow]] = newAccount;
			}

			// Se o canal não for null verifica se os inscritos,
			// videos e vizualizações são válidos
			if (channelUrl) {
				for (let k = subscribsRow; k <= viewsRow; k += 1) {
					if (!isCellValid(cRow[k])) cRow[k] = null;
					else cRow[k] = getImportNumber(cRow[k]);
				}

				// Insere a data no schema e caso ocorra erros insera a ultima data
				const newDate = getImportDate(cRow[dateRow], lastDate);
				lastDate = newDate;

				// Define os schemas e adicioana os dados dos atores
				const newHistory = {
					subscribers: cRow[subscribsRow],
					videos: cRow[videosRow],
					views: cRow[viewsRow],
					date: new Date(`${newDate[1]}/${newDate[0]}/${newDate[2]}`),
				};
				actors[cRow[nameRow]].history.push(newHistory);
			}
		}
	}

	const savePromises = [];
	Object.entries(actors).forEach(([cActor]) => {
		savePromises.push(actors[cActor].save());
	});
	await Promise.all(savePromises);

	return res.redirect("/youtube");
};

/**
 * Data recovery about a given user
 * @param {object} req - standard request object from the Express library
 * @param {object} res - standard response object from the Express library
 */
const getUser = async (req, res) => {
	try {
		const account = req.account[0].toObject();

		account.links = await getQueriesLink(req, account.channel); // eslint-disable-line

		res.status(httpStatus.OK).json({
			error: false,
			account,
		});
	} catch (error) {
		const errorMsg = "Erro enquanto configura-se o usuário";

		stdErrorHand(res, httpStatus.ERROR_GET_USER, errorMsg, error);
	}
};

/**
 * Data recovery latest about a given user
 * @param {object} req - standard request object from the Express library
 * @param {object} res - standard response object from the Express library
 */
const getLatest = (req, res) => {
	try {
		const history = req.account[0].toObject().history;
		const length = history.length - 1;
		const latest = {};
		const limit = ResocieObs.queriesRange.youtubeQueries;
		const queries = ResocieObs.queries.youtubeQueries;
		let count = 0;

		for (let ind = length; ind >= 0 || count <= limit; ind -= 1) {
			for (query of queries) {						// eslint-disable-line
				if (latest[query] === undefined				// eslint-disable-line
					&& history[ind][query] !== undefined) {	// eslint-disable-line
					latest[query] = history[ind][query];	// eslint-disable-line
					count += 1;
				}
			}
		}

		req.account[0].history.latest = latest;

		res.status(httpStatus.OK).json({
			error: false,
			latest,
		});
	} catch (error) {
		const errorMsg = `Error enquanto se recuperava os últimos dados válidos para o usuário [${req.account.name}], no ${capitalize(SOCIAL_MIDIA)}`;

		stdErrorHand(res, httpStatus.ERROR_LATEST, errorMsg, error);
	}
};

/**
 * Standard setting for generating a line chart
 * @param {object} req - standard request object from the Express library
 * @param {object} res - standard response object from the Express library
 * @param {object} next - standard next function
 * @returns Execution of the next feature, over the chart's configuration
 */
const drawLineChart = async (req, res) => {
	const mainLabel = req.chart.mainLabel;
	const datasets = req.chart.dataSets;
	const chartNode = new ChartNode(CHART_SIZE, CHART_SIZE);
	const labelXAxes = "Data";
	const labelYAxes = `Nº de ${req.chart.historyKeyPT}`;

	const config = {
		type: "line",
		data: {
			datasets: datasets,
		},
		options: {
			title: {
				display: true,
				text: mainLabel,
			},
			legend: {
				display: true,
				position: "top",
				labels: {
					padding: 15,
				},
			},
			scales: {
				xAxes: [{
					type: "time",
					time: {
						tooltipFormat: "ll HH:mm",
					},
					ticks: {
						major: {
							fontStyle: "bold",
						},
					},
					scaleLabel: {
						display: true,
						labelString: labelXAxes,
					},
				}],
				yAxes: [{
					scaleLabel: {
						display: true,
						labelString: labelYAxes,
					},
				}],
			},
		},
	};

	await chartNode.drawChart(config);
	const buffer = await chartNode.getImageBuffer("image/png");
	res.writeHead(httpStatus.OK, { "Content-Type": "image/png" });
	res.write(buffer);
	res.end();
};

/*	Route middlewares */
/**
 * Look for a specific registered Youtube account, by name.
 * @param {object} req - standard request object from the Express library
 * @param {object} res - standard response object from the Express library
 * @param {object} next - standard next function
 * @returns Execution of the next feature, over the data found
 */
const loadAccount = async (req, res, next) => {
	try {
		if (req.actors !== undefined) {
			for (const cActor of req.actors) {	// eslint-disable-line
				await findAccount(req, cActor);	// eslint-disable-line
			} 									// eslint-disable-line
		} else {
			const id = req.params.id;
			await findAccount(req, id);
		}

		return next();
	} catch (error) {
		let id;
		if (req.actors !== undefined) {
			id = req.actors;
		} else {
			id = req.params.id;
		}
		const errorMsg = `Error ao carregar usuário(s) [${id}] dos registros do ${capitalize(SOCIAL_MIDIA)}`;

		return stdErrorHand(res, httpStatus.ERROR_LOAD_ACCOUNT, errorMsg, error);
	}
};

/**
 * Layer to query requested identification
 * @param {object} req - standard request object from the Express library
 * @param {object} res - standard response object from the Express library
 * @param {object} next - standard next function
 * @returns Execution of the next feature, over the history key generated
 */
const setHistoryKey = (req, res, next) => {
	const queriesPT = ResocieObs.queriesPT.youtubeQueriesPT;
	const historyKey = req.params.query;
	const historyKeyPT = queriesPT[historyKey];
	const errorMsg = `Não existe a caracteristica [${historyKey}] para o ${capitalize(SOCIAL_MIDIA)}`;

	let mainLabel;

	if (historyKeyPT !== undefined) {
		mainLabel = evolutionMsg(historyKeyPT);
	} else {
		logger.error(`${errorMsg} - Tried to access ${req.originalUrl}`);
		return res.status(httpStatus.ERROR_QUERY_KEY).json({
			error: true,
			description: errorMsg,
		});
	}

	req.chart = {
		historyKey: historyKey,
		historyKeyPT: historyKeyPT,
		mainLabel: mainLabel,
	};

	return next();
};

/**
 * Split of actors to be compared
 * @param {object} req - standard request object from the Express library
 * @param {object} res - standard response object from the Express library
 * @param {object} next - standard next function
 */
const splitActors = (req, res, next) => {
	try {
		const actors = req.query.actors.split(",");

		if (actors.length <= 1) {
			throw new TypeError("Insufficient amount of actors for a comparison");
		}

		req.actors = actors;

		next();
	} catch (error) {
		const errorMsg = "Erro ao criar o ambiente para a comparação";

		stdErrorHand(res, httpStatus.ERROR_SPLIT_ACTORS, errorMsg, error);
	}
};

/**
 * Recovery of the requested historical data set
 * @param {object} req - standard request object from the Express library
 * @param {object} res - standard response object from the Express library
 * @param {object} next - standard next function
 * @returns Execution of the next feature, over the data set generated
 */
const getDataset = (req, res, next) => {
	const historyKey = req.chart.historyKey;
	const accounts = req.account;

	if (req.chart.dataSets === undefined) {
		req.chart.dataSets = [];
	}

	/*
	if (req.chart.data === undefined) {
		req.chart.data = [];
	}
	// */

	accounts.forEach((account) => {
		const dataUser = [];
		const history = account.history;
		const length = history.length;
		// const labels = [];

		for (let ind = 0; ind < length; ind += 1) {
			if (history[ind][historyKey] !== undefined
				&& history[ind][historyKey] !== null) {
				const date = new Date(history[ind].date);

				dataUser.push({
					x: date,
					y: history[ind][historyKey],
				});
				// labels.push(date);
			}
		}

		let label;
		if ((account.name.length + account.channelUrl.length) > MAX_LEN_LABEL) {
			label = `${account.name}\n(${account.channelUrl})`;
		} else {
			label = `${account.name} (${account.channelUrl})`;
		}

		const color = Color.getColor();
		const dataSet = {
			data: dataUser,
			backgroundColor: color,
			borderColor: color,
			fill: false,
			label: label,
		};

		req.chart.dataSets.push(dataSet);
		// req.chart.data.push(dataUser);
	});

	next();
};

/*	Methods of abstraction upon request */
/**
 * Search for an account in the records and making it available
 * @param {object} req - standard request object from the Express library
 * @param {object} id - standard identifier of a YouTune account
 */
const findAccount = async (req, id) => {
	const account = await youtubeAccount.findOne({ channel: id }, "-_id -__v");

	if (!account) throw TypeError(`There is no user [${id}]`);

	if (req.account === undefined) req.account = [];

	req.account.push(account);
};

/**
 * Acquiring the links to the home page
 * @param {object} req - standard request object from the Express library
 * @param {object} accounts - Accounts registered for Youtube
 */
const getInitialLink = (req, accounts) => {
	getAccountLink(req, accounts);
	return getImportLink(req, SOCIAL_MIDIA);
};

/**
 * Acquire links to all registered Youtube accounts
 * @param {object} req - standard request object from the Express library
 * @param {object} accounts - Accounts registered for Youtube
 */
const getAccountLink = (req, accounts) => {
	const length = accounts.length;

	for (let i = 0; i < length; i += 1) {
		accounts[i] = accounts[i].toObject();
		accounts[i].links = [];
		const id = accounts[i].channel;

		if (id) {
			const link = {
				rel: `${SOCIAL_MIDIA}.account`,
				href: `${req.protocol}://${req.get("host")}/${SOCIAL_MIDIA}/${id}`,
			};
			accounts[i].links.push(link);
		}
	}
};

/**
 * Acquiring link to import from Youtube accounts
 * @param {object} req - standard request object from the Express library
 */
const getImportLink = (req) => {
	return {
		rel: `${SOCIAL_MIDIA}.import`,
		href: `${req.protocol}://${req.get("host")}/${SOCIAL_MIDIA}/import`,
	};
};

/**
 * Acquiring the links to the possible queries for Youtbe
 * @param {object} req - standard request object from the Express library
 * @param {object} id - standard identifier of a Youtube account
 */
const getQueriesLink = (req, id) => {
	const links = [];
	const midiaQueries = ResocieObs.queries.youtubeQueries;

	links.push(getCommomLink(req, id));

	for (query of midiaQueries) {								// eslint-disable-line
		links.push(getQueryLink(req, id, query));	// eslint-disable-line
	}

	return links;
};

/**
 * Acquisition of the link to the common query among all social media
 * @param {object} req - standard request object from the Express library
 * @param {object} id - standard identifier of a Youtbe account
 */
const getCommomLink = (req, id) => {
	const commom = ResocieObs.queries.commonQuery;

	return {
		rel: `${SOCIAL_MIDIA}.account.${commom}`,
		href: `${req.protocol}://${req.get("host")}/${SOCIAL_MIDIA}/${commom}/${id}`,
	};
};

/**
 * Acquire the link to a given query for Youtube
 * @param {object} req - standard request object from the Express library
 * @param {object} id - standard identifier of a Youtube account
 * @param {object} query - query requested
 */
const getQueryLink = (req, id, query) => {
	return {
		rel: `${SOCIAL_MIDIA}.account.${query}`,
		href: `${req.protocol}://${req.get("host")}/${SOCIAL_MIDIA}/${id}/${query}`,
	};
};


/*	Methods of abstraction upon response */
/**
 * Standard Error Handling
 * @param {object} res - standard response object from the Express library
 * @param {String} errorMsg - error message for the situation
 * @param {object} error - error that actually happened
 */
const stdErrorHand = (res, errorCode, errorMsg, error) => {
	logger.error(`${errorMsg} - Detalhes: ${error}`);

	res.status(errorCode).json({
		error: true,
		description: errorMsg,
	});
};

/*	Methods of abstraction */
/**
 * Standard message for the analysis of the evolution of a characteristic
 * of a given account
 * @param {String} param - characteristic under analysis
 * @returns standard message generated
 */
const evolutionMsg = (param) => {
	return `Evolução de ${param}, no ${capitalize(SOCIAL_MIDIA)}`;
};

/**
 * Capitalization of a given string
 * @param {string} str - string for modification
 */
const capitalize = (str) => {
	return str.replace(/\b\w/g, l => l.toUpperCase()); // eslint-disable-line
};

/**
 * Data validation by recurrent criteria
 * @param {String} value - data to be validated
 * @returns true if it is not valid, false if it is valid
 */
const isCellValid = (value) => {
	if (!value) return false;

	value = value.toUpperCase();

	if (value === "-"
		|| value === "S"
		|| value === "S/") {
		return false;
	}

	return true;
};

/**
 * Acquire the channel link from the import base
 * @param {string} channelLink - supposed account link
 */
const getImportChannelURL = (channelLink) => {
	if (isCellValid(channelLink)) return channelLink;

	return null;
};

/**
 * Acquire the account username from the import base
 * @param {string} usernameRaw - supposed account username
 */
const getImportUsername = (usernameRaw) => {
	if (!(usernameRaw) || !(usernameRaw.includes(`${SOCIAL_MIDIA}.com`))) return null;

	let username = usernameRaw.replace(`https://www.${SOCIAL_MIDIA}.com/`, "");
	username = username.split("/");

	if (username[0] === "channel"
		|| username[0] === "user") {
		username = username[1];
	} else username = username[0];

	return username;
};

/**
 * Acquire a number from the import base
 * @param {string} number - supposed valid number
 */
const getImportNumber = (number) => {
	number = parseInt(number.replace(/\.|,/g, ""), 10);

	if (Number.isNaN(number)) number = null;

	return number;
};

/**
 * Acquire a date from the import base
 * @param {string} date - supposed valid date
 * @param {array} lastDate - last valid date
 */
const getImportDate = (date, lastDate) => {
	if (!date) return lastDate;

	date = date.split("/");

	if (!(date) || date.length !== 3) date = lastDate;

	return date;
};

module.exports = {
	listAccounts,
	importData,
	getUser,
	getLatest,
	drawLineChart,
	loadAccount,
	setHistoryKey,
	splitActors,
	getDataset,
	evolutionMsg,
	capitalize,
	isCellValid,
	getImportChannelURL,
	getImportUsername,
	getImportNumber,
	getImportDate,
};
