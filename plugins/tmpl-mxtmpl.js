/*
    对模板增加根变量的分析，模板引擎中不需要用with语句
 */
let acorn = require('acorn');
let walker = require('acorn/dist/walk');
let tmplCmd = require('./tmpl-cmd');
let configs = require('./util-config');
let Tmpl_Mathcer = /<%([@=!:~])?([\s\S]+?)%>|$/g;
let TagReg = /<([^>\s\/]+)([^>]*)>/g;
let BindReg = /([^>\s\/=]+)\s*=\s*(["'])\s*<%:([\s\S]+?)%>\s*\2/g;
let BindReg2 = /\s*<%:([\s\S]+?)%>\s*/g;
let PathReg = /<%~([\s\S]+?)%>/g;
let TextaraReg = /<textarea([^>]*)>([\s\S]*?)<\/textarea>/g;
let MxViewAttrReg = /\bmx-view\s*=\s*(['"])([^'"]+?)\1/;
let CReg = /[用声全未]/g;
let HReg = /([\u0001\u0002])\d+/g;
let HtmlHolderReg = /\u0005\d+\u0005/g;
let SCharReg = /(?:`;|;`)/g;
let StringReg = /^['"]/;
let BindFunctionsReg = /\{\s*([^\{\}]+)\}\s*$/;
let BindFunctionParamsReg = /,"([^"]+)"/;
let CMap = {
    '用': '\u0001',
    '声': '\u0002',
    '全': '\u0003',
    '未': '\u0006'
};
let StripChar = (str) => str.replace(CReg, (m) => CMap[m]);
let StripNum = (str) => str.replace(HReg, '$1');
let GenEventReg = (type) => {
    let reg = GenEventReg[type];
    if (!reg) {
        reg = new RegExp('\\bmx-' + type + '\\s*=\\s*"([^\\(]+)\\(([\\s\\S]*?)\\)"');
        GenEventReg[type] = reg;
    }
    reg.lastIndex = 0;
    return reg;
};
let SplitExpr = (expr) => {
    let stack = [];
    let temp = '';
    let max = expr.length;
    let i = 0,
        c, opened = 0;
    while (i < max) {
        c = expr.charAt(i);
        if (c == '.') {
            if (!opened) {
                if (temp) {
                    stack.push(temp);
                }
                temp = '';
            } else {
                temp += c;
            }
        } else if (c == '[') {
            if (!opened && temp) {
                stack.push(temp);
                temp = '';
            }
            opened++;
            temp += c;
        } else if (c == ']') {
            opened--;
            temp += c;
            if (!opened && temp) {
                stack.push(temp);
                temp = '';
            }
        } else {
            temp += c;
        }
        i++;
    }
    if (temp) {
        stack.push(temp);
    }
    return stack;
};

let ExtractFunctions = (expr) => {
    let m = expr.match(BindFunctionParamsReg);
    let fns = '';
    if (m) {
        fns = m[1];
        expr = expr.replace(BindFunctionParamsReg, '');
    }
    return {
        expr,
        fns
    };
};
/*
    \u0000  `反撇
    \u0001  模板中局部变量  用
    \u0002  变量声明的地方  声
    \u0003  模板中全局变量  全
    \u0004  命令中的字符串
    \u0005  html中的字符串
    \u0006  unchangableVars
    \u0007  存储命令
    \u0008  压缩命令
    \u0011  精准识别rqeuire
    \u0012  精准识别@符
    \u0017  模板中的纯字符串
    第一遍用汉字
    第二遍用不可见字符
 */
module.exports = {
    process: (tmpl, reject, sourceFile) => {
        let fn = [];
        let index = 0;
        let htmlStore = {};
        let htmlIndex = 0;
        tmpl = tmpl.replace(BindReg2, (m, expr) => {
            if (BindFunctionsReg.test(expr)) {
                expr = expr.replace(BindFunctionsReg, ',"\u0017$1"');
            }
            return ' <%:' + expr + '%> ';
        });
        //console.log(tmpl);
        tmpl.replace(Tmpl_Mathcer, (match, operate, content, offset) => {
            let start = 2;
            if (operate) {
                start = 3;
                content = '(' + content + ')';
            }
            let source = tmpl.slice(index, offset + start);
            let key = '\u0005' + (htmlIndex++) + '\u0005';
            htmlStore[key] = source;
            index = offset + match.length - 2;
            fn.push(';`' + key + '`;', content);
        });
        fn = fn.join(''); //移除<%%> 使用`变成标签模板分析
        let ast;
        let recoverHTML = (fn) => {
            fn = fn.replace(SCharReg, '');
            fn = fn.replace(HtmlHolderReg, (m) => htmlStore[m]);
            return fn;
        };
        //console.log('x', fn);
        //return;

        try {
            ast = acorn.parse(fn);
        } catch (ex) {
            console.log('parse html cmd ast error:', ex.message.red);
            let html = recoverHTML(fn.slice(Math.max(ex.loc.column - 5, 0)));
            console.log('near html:', (html.slice(0, 200)).green);
            console.log('html file:', sourceFile.red);
            reject(ex.message);
        }
        let globalExists = {};
        let globalTracker = {};
        for (let key in configs.tmplGlobalVars) {
            globalExists[key] = 1;
        }
        /*
            变量和变量声明在ast里面遍历的顺序不一致，需要对位置信息保存后再修改fn
         */
        let modifiers = [];
        let stringStore = {};
        let stringIndex = 0;
        let recoverString = (tmpl) => {
            return tmpl.replace(/(['"])(\u0004\d+\u0004)\1/g, (m, q, c) => {
                let str = stringStore[c].slice(1, -1);
                if (str.charAt(0) == '\u0017') {
                    return q + str.slice(1) + q;
                }
                return q + '\u0017' + str + '\u0017' + q;
            });
        };
        let fnProcessor = (node) => {
            if (node.type == 'FunctionDeclaration') {
                globalExists[node.id.name] = 1;
            }
            let params = {};
            for (let i = 0, p; i < node.params.length; i++) {
                p = node.params[i];
                params[p.name] = 1;
            }
            let walk = (expr) => {
                if (expr) {
                    if (expr.type == 'Identifier') {
                        if (params[expr.name]) { //如果在参数里，移除修改器里面的，该参数保持不变
                            for (let j = modifiers.length - 1; j >= 0; j--) {
                                let m = modifiers[j];
                                if (expr.start == m.start) {
                                    modifiers.splice(j, 1);
                                    break;
                                }
                            }
                        }
                    } else if (Array.isArray(expr)) {
                        for (let i = 0; i < expr.length; i++) {
                            walk(expr[i]);
                        }
                    } else if (expr instanceof Object) {
                        for (let p in expr) {
                            walk(expr[p]);
                        }
                    }
                }
            };
            walk(node.body.body);
        };
        let unchangableVars = Object.assign({}, configs.tmplUnchangableVars);
        walker.simple(ast, {
            CallExpression(node) {
                let vname = '';
                let callee = node.callee;
                if (callee.name) {
                    vname = callee.name;
                } else {
                    let start = callee.object;
                    while (start.object) {
                        start = start.object;
                    }
                    vname = start.name;
                }
                unchangableVars[vname] = 1;
                let args = configs.tmplPadCallArguments(vname, sourceFile);
                if (args && args.length) {
                    if (!Array.isArray(args)) {
                        args = [args];
                    }
                    for (let i = 0; i < args.length; i++) {
                        args[i] = '全.' + args[i];
                    }
                    modifiers.push({
                        key: '',
                        start: node.end - 1,
                        end: node.end - 1,
                        name: (node.arguments.length ? ',' : '') + args.join(',')
                    });
                }
            }
        });
        let processString = (node) => { //存储字符串，减少分析干扰
            StringReg.lastIndex = 0;
            if (StringReg.test(node.raw)) {
                let q = node.raw.match(StringReg)[0];
                let key = '\u0004' + (stringIndex++) + '\u0004';
                stringStore[key] = node.raw;
                modifiers.push({
                    key: '',
                    start: node.start,
                    end: node.end,
                    name: q + key + q
                });
            }
        };
        walker.simple(ast, {
            Property(node) {
                StringReg.lastIndex = 0;
                if (node.key.type == 'Literal') {
                    processString(node.key);
                }
            },
            Literal: processString,
            Identifier(node) {
                if (globalExists[node.name] !== 1) {
                    modifiers.push({
                        key: (unchangableVars[node.name] ? '未' : '全') + '.',
                        start: node.start,
                        end: node.end,
                        name: node.name
                    });
                } else {
                    if (!configs.tmplGlobalVars[node.name]) {
                        modifiers.push({
                            key: '用' + node.end,
                            start: node.start,
                            end: node.end,
                            name: node.name
                        });
                    }
                }
            },
            VariableDeclarator(node) {
                globalExists[node.id.name] = 1;
                modifiers.push({
                    key: '声' + node.start,
                    start: node.id.start,
                    end: node.id.end,
                    name: node.id.name
                });
            },
            FunctionDeclaration: fnProcessor,
            FunctionExpression: fnProcessor
        });
        //根据start大小排序，这样修改后的fn才是正确的
        modifiers.sort((a, b) => a.start - b.start);
        for (let i = modifiers.length - 1, m; i >= 0; i--) {
            m = modifiers[i];
            fn = fn.slice(0, m.start) + m.key + m.name + fn.slice(m.end);
        }
        //console.log(fn);
        ast = acorn.parse(fn);
        walker.simple(ast, {
            VariableDeclarator(node) {
                if (node.init) {
                    let key = StripChar(node.id.name);
                    let pos = key.match(/\u0002(\d+)/)[1];
                    key = key.replace(/\u0002\d+/, '\u0001');
                    let value = StripChar(fn.slice(node.init.start, node.init.end));
                    if (!globalTracker[key]) {
                        globalTracker[key] = [];
                    }
                    globalTracker[key].push({
                        pos: pos | 0,
                        value: value
                    });
                }
            }
        });
        //fn = StripChar(fn);
        fn = fn.replace(SCharReg, '');
        fn = StripChar(fn);

        fn = fn.replace(HtmlHolderReg, (m) => htmlStore[m]);
        fn = fn.replace(Tmpl_Mathcer, (match, operate, content) => {
            if (operate) {
                return '<%' + operate + content.slice(1, -1) + '%>';
            }
            return match; //移除代码中的汉字
        });
        let cmdStore = {};
        let best = (head) => {
            let match = head.match(/\u0001(\d+)/);
            if (!match) return null;
            let pos = match[1];
            pos = pos | 0;
            let key = head.replace(/\u0001\d+/, '\u0001');
            let list = globalTracker[key];
            if (!list) return null;
            for (let i = list.length - 1, item; i >= 0; i--) {
                item = list[i];
                if (item.pos < pos) {
                    return item.value;
                }
            }
            return null;
        };
        let find = (expr, srcExpr) => {
            if (!srcExpr) {
                srcExpr = expr;
            }
            //console.log('expr', expr);
            let ps = SplitExpr(expr); //expr.match(SplitExprReg);
            //console.log('ps', ps);
            let head = ps[0];
            if (head == '\u0003') {
                return ps.slice(1);
            }
            let info = best(head);
            if (!info) {
                console.log(('analyseExpr # can not analysis:' + srcExpr).red);
                return ['analysisError'];
            }
            if (info != '\u0003') {
                ps = find(info, srcExpr).concat(ps.slice(1));
            }
            return ps; //.join('.');
        };
        let analyseExpr = (expr) => {
            //console.log('expr', expr);
            let result = find(expr);
            //console.log('result', result);
            for (let i = 0, one; i < result.length; i++) {
                one = result[i];
                if (one.charAt(0) == '[' && one.charAt(one.length - 1) == ']') {
                    one = '<%=' + one.slice(1, -1) + '%>';
                }
                //one = StripNum(one);
                result[i] = one;
            }
            result = result.join('.');
            return result;
        };
        fn = tmplCmd.store(fn, cmdStore);
        fn = fn.replace(TextaraReg, (match, attr, content) => {
            attr = tmplCmd.recover(attr, cmdStore);
            content = tmplCmd.recover(content, cmdStore);
            if (BindReg2.test(content)) {
                let bind = '';
                content = content.replace(BindReg2, (m) => {
                    bind = m;
                    return m.replace('<%:', '<%=');
                });
                attr = attr + ' ' + bind;
            }
            content = tmplCmd.store(content, cmdStore);
            attr = tmplCmd.store(attr, cmdStore);
            return '<textarea' + attr + '>' + content + '</textarea>';
        });
        fn = fn.replace(TagReg, (match, tag, attrs) => {
            let bindEvents = configs.bindEvents;
            let oldEvents = {};
            let e;
            let hasMagixView = MxViewAttrReg.test(attrs);
            //console.log(cmdStore, attrs);
            attrs = tmplCmd.recover(attrs, cmdStore, recoverString);
            let replacement = (m, name, params) => {
                let now = ',m:\'' + name + '\',a:' + (params || '{}');
                let old = m; //tmplCmd.recover(m, cmdStore);
                oldEvents[e] = {
                    old: old,
                    now: now
                };
                return old;
            };
            for (let i = 0; i < bindEvents.length; i++) {
                e = bindEvents[i];
                let reg = GenEventReg(e);
                attrs = attrs.replace(reg, replacement);
            }
            let findCount = 0;
            let transformEvent = (exprInfo) => {
                let expr = exprInfo.expr;
                let f = '';
                let fns = exprInfo.fns;
                if (fns.length) {
                    f = ',f:\'' + fns.replace(/[\u0001\u0003\u0006]\d*\.?/g, '') + '\'';
                }
                expr = analyseExpr(expr);
                let now = '',
                    info;
                for (let i = 0; i < bindEvents.length; i++) {
                    e = bindEvents[i];
                    info = oldEvents[e];
                    now += '  mx-' + e + '="' + configs.bindName + '({p:\'' + expr + '\'' + (info ? info.now : '') + f + '})"';
                }
                return now;
            };
            attrs = attrs.replace(BindReg, (m, name, q, expr) => {
                expr = expr.trim();
                if (findCount > 1) {
                    console.log('unsupport multi bind', expr, attrs, tmplCmd.recover(match, cmdStore, recoverString), ' relate file:', sourceFile.gray);
                    return '';
                }
                findCount++;

                let exprInfo = ExtractFunctions(expr);
                let now = transformEvent(exprInfo);

                let replacement = '<%=';
                if (hasMagixView && name.indexOf('view-') === 0) {
                    replacement = '<%@';
                }
                m = name + '=' + q + replacement + exprInfo.expr + '%>' + q;
                return m + now;
            }).replace(BindReg2, (m, expr) => {
                expr = expr.trim();
                if (findCount > 1) {
                    console.log('unsupport multi bind', expr, attrs, tmplCmd.recover(match, cmdStore, recoverString), ' relate file:', sourceFile.gray);
                    return '';
                }
                findCount++;
                let exprInfo = ExtractFunctions(expr);
                let now = transformEvent(exprInfo);
                return now;
            }).replace(PathReg, (m, expr) => {
                expr = expr.trim();
                expr = analyseExpr(expr);
                return expr;
            }).replace(Tmpl_Mathcer, (m) => {
                return StripNum(m);
            });
            if (findCount > 0) {
                for (let i = 0; i < bindEvents.length; i++) {
                    e = oldEvents[bindEvents[i]];
                    if (e) {
                        attrs = attrs.replace(e.old, '');
                    }
                }
            }
            return '<' + tag + attrs + '>';
        });

        let processCmd = (cmd) => {
            return recoverString(StripNum(cmd));
        };
        fn = tmplCmd.recover(fn, cmdStore, processCmd);
        //console.log(fn);
        return fn;
    }
};