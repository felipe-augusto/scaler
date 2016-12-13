var fs = require('fs');
var request = require('request');
var async = require('async');
var _ = require('lodash');
var parseDomain = require('parse-domain');

var INFO = JSON.parse(process.env.INFO);

var tmp = parseDomain(INFO.cloudflare.domain);
var root_domain = tmp.domain + '.' + tmp.tld;
var elapsed_time = new Date().getTime();

var DOMAIN =  INFO.cloudflare.domain;
var ROOT_DOMAIN = root_domain;
var MIN = INFO.scaler_rules.min;
var MAX = INFO.scaler_rules.min;

var CFClient = require('cloudflare');
var client = new CFClient({
    email: INFO.cloudflare.email,
    key: INFO.cloudflare.key
});

var cpu = "/api/v1/data?chart=system.cpu&format=array&points=" + INFO.scaler_rules.interval + "&group=average&options=absolute|jsonwrap|nonzero&after=-" + INFO.scaler_rules.interval;

var DigitalOcean = require('do-wrapper');

api = new DigitalOcean(INFO.digital_ocean.key, 1000);

setInterval(routine, 10000);

function routine () {
	api.dropletsGetAll({tag_name : INFO.project + "-slave"}, function (err, data, body) {
		var num_droplets = body.droplets.length;
		async.map(body.droplets, getDropletData, function (err, results) {
			// all droplets are functioning properly
			console.log(results);
			if(num_droplets == results.length) {
				// need to check if the droplets has DNS
				client.browseZones({name : ROOT_DOMAIN}).then(function (value) {
					// domains does not have ZONE
					if(value.result.length == 0) {
						// throw error
						console.log('Erro: Arquivo de zona nao encontrado. Este dominio esta cadastrado no CloudFlare?');
					} else {
						// domain has zone
						var zone = value.result[0].id;
						// check all DNS records for that zone
						client.browseDNS(zone).then(function (value) {
							value = value.result.map(function(item) {
								return item.name;
							});
							results.map(function (item) {
								// if not on DNS we should put it
								if(!_.includes(value, item)) {
									createDNSRecord(item, zone, function (resp) {
										console.log(resp);
									})
								};
							})
						})
					};
				});
				// check scaler rules
				async.map(body.droplets, getInfoDroplet, function (err, results) {
					if(results.length != 0) {
						var now_time = new Date().getTime();
						var diff = (now_time - elapsed_time) / 1000;
						var average = results.reduce(function(a, b) { return a + b; }) / results.length;
						console.log(diff, average);
						// scale down rule
						if(average < INFO.scaler_rules.down.percent && body.droplets.length > INFO.scaler_rules.min && diff > INFO.scaler_rules.interval) {
							var droplet_id = body.droplets[body.droplets.length - 1].id;
							var droplet_ip = body.droplets[body.droplets.length - 1].networks.v4[0].ip_address;
							// domains does not have ZONE
							client.browseZones({name : ROOT_DOMAIN}).then(function (value) {
								if(value.result.length == 0) {
									// throw error
									console.log('Erro: Arquivo de zona nao encontrado. Este dominio esta cadastrado no CloudFlare?');
								} else {
									// domain has zone
									var zone = value.result[0].id;
									// check all DNS records for that zone
									client.browseDNS(zone, {content : droplet_ip}).then(function (value) {
										client.deleteDNS(value.result[0]).then(function (value) {
											console.log(value);
											api.dropletsDelete(droplet_id, function (resp) {
												console.log(resp);
												// change elapsed
												elapsed_time = new Date().getTime() - 120;
											})
										})
									})
								};
							});
						}
						// scale up rule
						if(average > INFO.scaler_rules.up.percent && body.droplets.length < INFO.scaler_rules.max && diff > INFO.scaler_rules.interval) {
							var slave_conf = fs.readFileSync('slave.conf', 'utf8');
							slave_conf = slave_conf.replace(/\$\(folder\)/g, splitGit(INFO.git));
							slave_conf = slave_conf.replace(/\$\(url\)/g, INFO.git);
							slave_conf = slave_conf.replace(/\$\(port\)/g, INFO.port);
							api.dropletsCreate({
								"name": INFO.project + "-slave." + Math.floor((Math.random() * 1000) + 1),
								"region": INFO.digital_ocean.region,
								"size": INFO.digital_ocean.size,
								"image": "docker",
								"ssh_keys": null,
								"backups": false,
								"ipv6": false,
								"private_networking": false,
								"tags": [
									INFO.project + "-slave",
									INFO.project
								],
								"user_data": slave_conf
							},function (err, res, body) {
									console.log(err);
									elapsed_time = new Date().getTime() - 180;
							});
						}
					} else {
						elapsed_time = new Date().getTime();
						console.log("Nenhum droplet online");
					}
				})
			} else {
				// some droplet is not functioning properly
				// perhaps is a recent start
				console.log("num diff");
			}
		});
	})
}

function getDropletData(droplet, cb) {
	request.get("http://" + droplet.networks.v4[0].ip_address + ":19999" + cpu, function(err, data, body) {
		if(err) {
			elapsed_time = new Date().getTime();
			cb(null, null);
		} else {
			cb(null, { "server" : "s" + droplet.name.split(".")[1] + "." + ROOT_DOMAIN, "ip" : droplet.networks.v4[0].ip_address});
		}
	})
}

function createDNSRecord(item, zone, cb) {
	// ns record
	// var ns = CFClient.DNSRecord.create({ 
	// 	zone_id: zone,
	// 	type: 'NS',
	// 	name: domain,
	// 	content: item.server
	// });
	// a record
	var a = CFClient.DNSRecord.create({ 
		zone_id: zone,
		type: 'A',
		name: DOMAIN,
		content: item.ip,
		ttl: 120
	});
	client.addDNS(a).then(function (value) {
			cb(true);
	})
	
}

function getInfoDroplet(droplet, cb) {
	request.get("http://" + droplet.networks.v4[0].ip_address + ":19999" + cpu, function(err, data, body) {
		if(err) {
			cb(null, null);
		} else {
			var resp = JSON.parse(body).result;
			cb(null, resp.reduce(function(a, b) { return a + b; }) / resp.length);
		}
	})
};

function splitGit(url) {
	var tamanho = url.split("/").length;
	var pre = url.split("/")[tamanho - 1];
	return pre.split(".")[0];
}