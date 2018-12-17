var debug = require('debug')('database-executor:database-executor');
var databaseConnector = require('node-database-connectors');
var databaseExecutor = require('./ConnectorIdentifier.js');
var axiomUtils = require("axiom-utils");
if (global._connectionPools == null) {
  global._connectionPools = {};
}
var oldResults = {};

function prepareQuery(dbConfig, queryConfig, cb) {
  try {
    var objConnection = databaseConnector.identify(dbConfig);
    var query = objConnection.prepareQuery(queryConfig);
    cb({
      status: true,
      content: query
    });
  } catch (ex) {
    console.log('exception: ', ex);
    var e = ex;
    //e.exception=ex;
    cb({
      status: false,
      error: e
    });
  }
}

function executeRawQueryWithConnection(dbConfig, rawQuery, cb) {
  try {
    var objConnection = databaseConnector.identify(dbConfig);
    objConnection.connect(dbConfig, function(err, connection) {
      if (err != undefined) {
        console.log('connection error: ', err);
        var e = err;
        //e.exception=ex;
        cb({
          status: false,
          error: e
        });
      } else {
        var objExecutor = databaseExecutor.identify(dbConfig);
        objExecutor.executeQuery(connection, rawQuery, function(result) {
          objConnection.disconnect(connection);
          cb(result);
        });
      }
    });
  } catch (ex) {
    console.log('exception: ', ex);
    var e = ex;
    //e.exception=ex;
    cb({
      status: false,
      error: e
    });
  }
}

exports.executeRawQuery = function(requestData, cb) {
  // debug('dbcon req:\nrequestData: %s', JSON.stringify(requestData));
  var dbConfig = requestData.dbConfig;
  var rawQuery = requestData.query;
  var tableName = requestData.table;
  var shouldCache = requestData.hasOwnProperty('shouldCache') ? requestData.shouldCache : false;
  executeRawQuery(dbConfig, rawQuery, shouldCache, tableName, cb);
}

exports.executeQuery = function(requestData, cb) {
  //debug('dbcon req:\nrequestData: %s', JSON.stringify(requestData));
  var dbConfig = requestData.dbConfig;
  var queryConfig = requestData.query;
  var shouldCache = requestData.hasOwnProperty('shouldCache') ? requestData.shouldCache : false;

  prepareQuery(dbConfig, queryConfig, function(data) {
    //     debug('prepareQuery', data);
    if (data.status == true) {
      executeRawQuery(dbConfig, data.content, shouldCache, queryConfig.table, cb);
    } else {
      cb(data);
    }
  });
}

exports.executeQueryStream = function(requestData, onResultFunction, cb) {
  var dbConfig = requestData.dbConfig;
  var query = requestData.rawQuery;
  var objConnection = databaseConnector.identify(dbConfig);
  objConnection.connect(dbConfig, function(err, connection) {
    if (err != undefined) {
      console.log('connection error: ', err);
      var e = err;
      //e.exception=ex;
      cb({
        status: false,
        error: e
      });
    } else {
      var objExecutor = databaseExecutor.identify(dbConfig);
      objExecutor.executeQueryStream(connection, query, onResultFunction, cb);
    }
  });
}


// DS : Handle Multiple Queries with same connection similar to batch queries;

function executeRawQueryWithConnectionPool(dbConfig, rawQuery, cb) {
  try {
    var startTime = new Date();
    getConnectionFromPool(dbConfig, function(result) {
      if (result.status === false) {
        cb(result);
      } else {
        var connection = result.content;
        if (rawQuery.length <= 100000000) {
          debug('query: %s', rawQuery);
        } else {
          debug('query: %s', rawQuery.substring(0, 500) + "\n...\n" + rawQuery.substring(rawQuery.length - 500, rawQuery.length));
        }
        var queryStartTime = new Date();
        var objExecutor = databaseExecutor.identify(dbConfig);
        objExecutor.executeQuery(connection, rawQuery, function(result) {
          if (result.status == false) {
            console.log("DB Executor Error", dbConfig, rawQuery);
          }
          debug("Total Time:", (new Date().getTime() - startTime.getTime()) / 1000, "Query Time:", (new Date().getTime() - queryStartTime.getTime()) / 1000);
          cb(result);
        });
      }
    });
  } catch (ex) {
    console.log('exception: ', ex);
    var e = ex;
    //e.exception=ex;
    cb({
      status: false,
      error: e
    });
  }
}


function executeRawQuery(dbConfig, rawQuery, shouldCache, tableName, cb) {
  if (!tableName) {
    tableName = "#$table_name_not_available$#";
  }
  var dbConf = JSON.stringify({host:dbConfig.host,port:dbConfig.port});
  if (shouldCache == true && oldResults[dbConf] && oldResults[dbConf][tableName] && oldResults[dbConf][tableName][rawQuery]) {
    var result = oldResults[dbConf][tableName][rawQuery].result;
    if(dbConfig.databaseType == 'redshift'){
      result = result.map(d => {
        return (!Array.isArray(d) ? convertObject(d) : d.map(innerD => {
          return convertObject(innerD);
        }));
      });
    }else{
      result = axiomUtils.extend(true,[],result);
    }
    cb({ status: true, content: result });
  } else {
    if (dbConfig.hasOwnProperty('connectionLimit') && dbConfig.connectionLimit == 0) {
      debug("With New Connection");
      executeRawQueryWithConnection(dbConfig, rawQuery, function(responseData) {
        cb(responseData)
        if (shouldCache == true && responseData.status == true) {
          saveToCache(responseData.content, dbConfig, rawQuery, tableName)
        }
      });
    } else {
      debug("With Connection Pool");
      executeRawQueryWithConnectionPool(dbConfig, rawQuery, function(responseData) {
        cb(responseData)
        if (shouldCache == true && responseData.status == true) {
          saveToCache(responseData.content, dbConfig, rawQuery, tableName)
        }
      });
    }
  }
}


function getConnectionFromPool(dbConfig, cb) {
  try {
    var connectionString = (dbConfig.databaseType + '://' + dbConfig.user + ':' + dbConfig.password + '@' + dbConfig.host + ':' + dbConfig.port + '/' + dbConfig.database);
    if (global._connectionPools.hasOwnProperty(connectionString)) {
      cb({
        status: true,
        content: global._connectionPools[connectionString]
      });
      return;
    } else {
      var objConnection = databaseConnector.identify(dbConfig);
      objConnection.connectPool(dbConfig, function(err, pool) {
        if (err != undefined) {
          console.log('connection error: ', err);
          var e = err;
          //e.exception=ex;
          cb({
            status: false,
            error: e
          });
        } else {
          global._connectionPools[connectionString] = pool;
          cb({
            status: true,
            content: pool
          });
        }
      });
    }
  } catch (ex) {
    console.log('exception: ', ex);
    var e = ex;
    //e.exception=ex;
    cb({
      status: false,
      error: e
    });
  }
}


function saveToCache(finalData, dbConfig, queryString, tableName) {
  var dbConf = JSON.stringify({host:dbConfig.host,port:dbConfig.port});
  if (!oldResults[dbConf]) {
    oldResults[dbConf] = {};
  }
  if (!oldResults[dbConf][tableName]) {
    oldResults[dbConf][tableName] = {}
  }
  oldResults[dbConf][tableName][queryString] = {
    result: finalData
  };
  // console.log("################################## JSON.stringify(oldResults) ###########################################")
  // console.log(JSON.stringify(oldResults))
  // console.log("################################## JSON.stringify(oldResults) ###########################################")

}


exports.flushCache = function(dbConfig, tableName) {
  var dbConf = JSON.stringify({host:dbConfig.host,port:dbConfig.port});
  if (oldResults[dbConf]) {
    if (oldResults[dbConf][tableName]) {
      oldResults[dbConf][tableName] = {};
    }
  }
}

function convertObject(row) {
  return new Proxy(row, {
    get: function(target, name) {
      if (typeof name !== 'string') {
        return undefined;
      }
      if (!(name.toLowerCase() in target)) {
        return undefined;
      }
      return target[name.toLowerCase()];
    },
    set: function(target, name, value) {
      if (typeof name !== 'string') {
        return undefined;
      }
      target[name.toLowerCase()] = value;
    }
  });
}

function executeRawQueriesWithSpecificConnection(dbConfig, connection, queries, cb){
  var objExecutor = databaseExecutor.identify(dbConfig);
  var allErrs = [], allResults = [], allFields = [];
  function processQuery(index){
    if(index>=queries.length || (allErrs.length && allErrs[allErrs.length-1])){
      cb(allErrs, allResults, allFields);
      return;
    }
    objExecutor.executeQuery(connection, queries[index], function(result) {
      if(result.status){
        allErrs.push(null);
        allResults.push(result.content);
      } else {
        allErrs.push(result.error);
        allResults.push(null);
      }
      allFields.push(null);
      processQuery(index + 1);
    });
  }
  processQuery(0);
}
exports.executeRawQueriesWithConnection = function(requestData, cb) {
  try {
    var dbConfig = requestData.dbConfig;
    var rawQueries = requestData.rawQueries;
    var objConnection = databaseConnector.identify(dbConfig);
    objConnection.connect(dbConfig, function(err, connection) {
      if (err != undefined) {
        console.log('connection error: ', err);
        var e = err;
        //e.exception=ex;
        cb({
          status: false,
          error: e
        });
      } else {
        executeRawQueriesWithSpecificConnection(dbConfig, connection, rawQueries, function(allErrs, allResults, allFields){
          objConnection.disconnect(connection);
          cb(allErrs, allResults, allFields);
        });
      }
    });
  } catch (ex) {
    console.log('exception: ', ex);
    var e = ex;
    //e.exception=ex;
    cb({
      status: false,
      error: e
    });
  }
}
